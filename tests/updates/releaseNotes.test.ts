import { describe, expect, it } from 'vitest'
import { normalizeReleaseNotes, releaseNoteItems } from '../../src/main/updates/releaseNotes'
import { channelForVersion } from '../../src/shared/updates'

const REPO = 'https://github.com/mousse-agent/mousse'

// The shape GitHub's atom feed carries for generated notes, as electron-updater passes it on.
const GENERATED = `<p>Nightly build of d909e8ddb6b3. Unsigned and not tested by hand; use a stable release for daily work.</p>
<h2>What's Changed</h2>
<ul>
<li>fix(theme): rename Blacksphere+ to mousse dark by <a class="user-mention" href="https://github.com/TheAnimatrix">@TheAnimatrix</a> in <a href="https://github.com/mousse-agent/mousse/pull/5">https://github.com/mousse-agent/mousse/pull/5</a></li>
<li>docs: <code>A &amp; B</code> &lt;3 &#x2014; done by @x in https://github.com/mousse-agent/mousse/pull/7</li>
</ul>
<h2>New Contributors</h2>
<ul><li>@x made their first contribution in https://github.com/mousse-agent/mousse/pull/7</li></ul>
<p><strong>Full Changelog</strong>: <a href="https://github.com/mousse-agent/mousse/commits/v0.1.2-nightly.20261021.2">https://github.com/…</a></p>`

describe('release notes', () => {
  it('keeps the changes from generated notes as plain text, with pull requests as numbers', () => {
    expect(releaseNoteItems(GENERATED)).toEqual([
      'fix(theme): rename Blacksphere+ to mousse dark by @TheAnimatrix in #5',
      'docs: A & B <3 — done by @x in #7'
    ])
  })

  it('reads lines when there is no list, skipping headings and the changelog link', () => {
    expect(releaseNoteItems('## What\'s Changed\n* one\n- two\n\n**Full Changelog**: x')).toEqual(['one', 'two'])
    expect(releaseNoteItems(null)).toEqual([])
  })

  it('caps releases and items, counts what was cut and links each release', () => {
    const many = `<ul>${Array.from({ length: 11 }, (_, index) => `<li>change ${index}</li>`).join('')}</ul>`
    const raw = Array.from({ length: 8 }, (_, index) => ({ version: `0.1.2-nightly.2026102${index}.${index}`, note: many }))
    const { releaseNotes, omittedReleaseCount } = normalizeReleaseNotes(raw, raw[0]!.version, REPO)
    expect(releaseNotes).toHaveLength(6)
    expect(omittedReleaseCount).toBe(2)
    expect(releaseNotes[0]).toMatchObject({ totalItems: 11, url: `${REPO}/releases/tag/v0.1.2-nightly.20261020.0` })
    expect(releaseNotes[0]!.items).toHaveLength(8)
  })

  it('treats a single note as the latest version and truncates long items', () => {
    const { releaseNotes } = normalizeReleaseNotes(`<ul><li>${'x'.repeat(400)}</li></ul>`, '0.1.3', REPO)
    expect(releaseNotes[0]!.version).toBe('0.1.3')
    expect(releaseNotes[0]!.items[0]).toHaveLength(220)
    expect(releaseNotes[0]!.items[0]!.endsWith('…')).toBe(true)
  })
})

describe('channelForVersion', () => {
  it.each([
    ['0.1.2-nightly.20261021.2', 'nightly'],
    ['0.1.2', 'stable'],
    ['0.1.2-beta.1', 'stable'],
    ['0.1.2-nightly', 'stable']
  ])('%s follows %s', (version, channel) => {
    expect(channelForVersion(version)).toBe(channel)
  })
})
