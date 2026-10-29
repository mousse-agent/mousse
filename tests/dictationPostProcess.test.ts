import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DICTATION_VOCABULARY,
  applyVocabulary,
  expandSpokenSymbols,
  formatVocabularyText,
  joinTranscriptSegments,
  parseVocabularyText,
  polishTranscript,
  structureTranscript,
  tidyPunctuation
} from '../src/shared/dictationPostProcess'

/** A real Parakeet TDT 110M transcript of a four-point request, before any cleanup. */
const RAW =
  'Okay, so create a detailed plan for the following work. So point number one. So in MOVES there is this computer you know icon button in the composer toolbar for new threads but this computer button cannot be toggled. to other computers in the same MOSID or MOS plus. Please fix that. Okay. So next point number two whenever there is a new model release in say Con X or Grog, these model releases. Never make it to the models list automatically. So for every provider makes sure. that the models list is being updated automatically. Point number three number three is So there is this widen window to show thread icon button in Moose So that is kind of not working in the laptop view. That\'s one thing and now moving on to point number four we have an issue with the MOSID login pop up. Then you can look at dot dot slash MOS hyphen plus repository. And the dot dot slash MOOS hyphen client repository. You have to ask the implement agent to use multiple subagents preferably sonic five point five subagents.'

const defaults = { vocabulary: DEFAULT_DICTATION_VOCABULARY, expandSymbols: true, detectLists: true }

describe('joinTranscriptSegments', () => {
  it('drops the full stop a segment cut leaves in the middle of a sentence', () => {
    expect(joinTranscriptSegments(['this button cannot be toggled.', 'to other computers.'])).toBe('this button cannot be toggled to other computers.')
    expect(joinTranscriptSegments(['So for every provider makes sure.', 'that the list is updated.'])).toBe('So for every provider makes sure that the list is updated.')
  })

  it('lowercases a capital that follows an unfinished segment, except I', () => {
    expect(joinTranscriptSegments(['it has some gap towards the right side,', 'Till the edge'])).toBe('it has some gap towards the right side, till the edge')
    expect(joinTranscriptSegments(['and then', 'I attach the screenshot'])).toBe('and then I attach the screenshot')
  })

  it('keeps real sentence boundaries and skips empty segments', () => {
    expect(joinTranscriptSegments(['Please fix that.', '', 'Next point.'])).toBe('Please fix that. Next point.')
    expect(joinTranscriptSegments(['part0', 'part1', 'part2'])).toBe('part0 part1 part2')
  })
})

describe('applyVocabulary', () => {
  it('matches all-capital entries exactly and others without regard to case', () => {
    expect(applyVocabulary('in MOVES the moves panel moves; Moose and MOOSE', DEFAULT_DICTATION_VOCABULARY)).toBe(
      'in mousse the moves panel moves; mousse and mousse'
    )
  })

  it('prefers the longest phrase and stops at word boundaries', () => {
    expect(applyVocabulary('MOSID or MOS plus or mosaic', DEFAULT_DICTATION_VOCABULARY)).toBe('mousse ID or mousse plus or mosaic')
    expect(applyVocabulary('say Con X or Grog or groggy', DEFAULT_DICTATION_VOCABULARY)).toBe('say Codex or Grok or groggy')
  })

  it('ignores entries with an empty side and escapes regex characters', () => {
    expect(applyVocabulary('a+b', [{ spoken: 'a+b', written: 'sum' }, { spoken: '', written: 'x' }])).toBe('sum')
  })
})

describe('expandSpokenSymbols', () => {
  it('writes paths, hyphens and file names', () => {
    expect(expandSpokenSymbols('look at dot dot slash MOS hyphen plus repository')).toBe('look at ../MOS-plus repository')
    expect(expandSpokenSymbols('open dot slash src slash shared slash config dot json')).toBe('open ./src/shared/config.json')
    expect(expandSpokenSymbols('the my underscore var name')).toBe('the my_var name')
  })

  it('writes decimal numbers', () => {
    expect(expandSpokenSymbols('sonnet five point five and 4 point 1')).toBe('sonnet 5.5 and 4.1')
    expect(expandSpokenSymbols('the main point is clear')).toBe('the main point is clear')
  })
})

describe('structureTranscript', () => {
  it('turns counted points into a numbered list with the intro as its own paragraph', () => {
    const text = 'Create a plan. So point number one. So fix the button. Okay. So next point number two the models list. Point number three number three is So the scroll bar. and now moving on to point number four the pop up.'
    expect(structureTranscript(text)).toBe(
      'Create a plan.\n\n1. Fix the button.\n\n2. The models list.\n\n3. The scroll bar.\n\n4. The pop up.'
    )
  })

  it('also understands "number two is" and ignores a single or descending point', () => {
    expect(structureTranscript('first thing. number one is the button. number two is the list')).toBe('first thing.\n\n1. The button.\n\n2. The list')
    expect(structureTranscript('point number one is the only one')).toBe('point number one is the only one')
    expect(structureTranscript('point number two then point number one')).toBe('point number two then point number one')
  })
})

describe('tidyPunctuation', () => {
  it('fixes spacing, doubled full stops and capitals after sentences', () => {
    expect(tidyPunctuation('done .. Next thing! and so on  here')).toBe('done. Next thing! And so on here')
    expect(tidyPunctuation('cannot be toggled. to other computers. Please fix that.')).toBe('cannot be toggled to other computers. Please fix that.')
    expect(tidyPunctuation('see e.g. this')).toBe('see e.g. this')
    expect(tidyPunctuation('look at ../mousse-plus and 5.5')).toBe('look at ../mousse-plus and 5.5')
  })
})

describe('polishTranscript', () => {
  it('cleans the real transcript end to end', () => {
    const polished = polishTranscript(RAW, defaults)
    expect(polished).toContain('1. In mousse there is this computer')
    expect(polished).toContain('cannot be toggled to other computers in the same mousse ID or mousse plus')
    expect(polished).toContain('for every provider makes sure that the models list')
    expect(polished).toContain('2. Whenever there is a new model release in say Codex or Grok')
    expect(polished).toContain('3. There is this widen window to show thread icon button in mousse')
    expect(polished).toContain('4. We have an issue with the mousse ID login pop up')
    expect(polished).toContain('look at ../mousse-plus repository')
    expect(polished).toContain('the ../mousse-client repository')
    expect(polished).toContain('preferably Sonnet 5.5 subagents')
    expect(polished.startsWith('Okay, so create a detailed plan for the following work.\n\n1. ')).toBe(true)
    expect(polished).not.toMatch(/\bpoint number\b/i)
  })

  it('leaves the text flat when list detection and symbols are off', () => {
    const polished = polishTranscript(RAW, { vocabulary: [], expandSymbols: false, detectLists: false })
    expect(polished).toContain('point number one')
    expect(polished).toContain('dot dot slash MOS hyphen plus')
  })

  it('changes nothing on a second pass', () => {
    const once = polishTranscript(RAW, defaults)
    expect(polishTranscript(once, defaults)).toBe(once)
  })
})

describe('vocabulary text', () => {
  it('round-trips "spoken = written" lines and skips malformed ones', () => {
    const entries = parseVocabularyText('gh-rysp = gh-ryspa\n\nno separator\n = missing\nCon X = Codex')
    expect(entries).toEqual([
      { spoken: 'gh-rysp', written: 'gh-ryspa' },
      { spoken: 'Con X', written: 'Codex' }
    ])
    expect(formatVocabularyText(entries)).toBe('gh-rysp = gh-ryspa\nCon X = Codex')
  })
})
