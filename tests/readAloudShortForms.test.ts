import { describe, expect, it } from 'vitest'
import { kokoroPhonemes } from '../src/main/readAloud/kokoroText'
import { phonemizeKeepingPunctuation } from '../src/renderer/readAloud/espeakPhonemes'
import { looksEnglish, spokenShortForms, spokenShortFormsIfEnglish } from '../src/renderer/readAloud/shortForms'
import { spokenEnglish } from '../src/renderer/readAloud/spokenEnglish'

describe('spokenShortForms', () => {
  it.each([
    // Chat short forms are said as words, in any letter case.
    ['IDK, maybe later.', "I don't know, maybe later."],
    ['idk tbh', "I don't know to be honest"],
    ['TL;DR: it works.', 'T L D R: it works.'],
    ['Press Ctrl+C.', 'Press control+C.'],
    // Capital initialisms without a vowel are spelled by rule.
    ['The PR is open.', 'The P R is open.'],
    ['Run it in WSL over RPC.', 'Run it in W S L over R P C.'],
    // Initialisms with a vowel are spelled only when listed.
    ['The CLI and the UI.', 'The C L I and the U I.'],
    // Latin and symbol short forms; "etc." keeps its period at a sentence end, also before a closer.
    ['Fruit, e.g. apples, etc. Then more.', 'Fruit, for example apples, et cetera. Then more.'],
    ['Apples, pears, etc. are fine.', 'Apples, pears, et cetera are fine.'],
    ['(Apples, etc.) Then more.', '(Apples, et cetera.) Then more.'],
    ['Tabs vs spaces, w/o tests.', 'Tabs versus spaces, without tests.'],
    ['VS Code vs. Zed', 'V S Code versus Zed'],
    ['Add e2e tests for i18n.', 'Add end to end tests for internationalization.']
  ])('writes %j as %j', (input, spoken) => {
    expect(spokenShortForms(input)).toBe(spoken)
  })

  it.each([
    // Said as words.
    'JSON, WASM, ONNX, RAM, YAML, CORS and REST.',
    // Shouted words and interjections.
    'STOP. NOTE: TODO, README, OK, YES, NO. HMM.',
    // Plurals and possessives, which the voices say better as written.
    "Two PRs and the LLM's answer.",
    // Mixed case, inside longer words, paths and code names.
    'SQLite, iOS, MCPServer, PR_NUMBER, Ms. Smith, tests/e2e/foo.ts and process.stdout.write.'
  ])('leaves %j for the voice to say as written', (text) => {
    expect(spokenShortForms(text)).toBe(text)
  })

  it('leaves units and times after a number for the number reader', () => {
    const text = 'It took 512 MB, 4 KB, 2 TB and 2 GB at 3:30 PM, in 30 MS.'
    expect(spokenEnglish(spokenShortForms(text))).toBe(spokenEnglish(text))
    expect(spokenEnglish(spokenShortForms(text))).toContain('five hundred twelve megabytes')
  })

  it('changes only text that looks English for voices that speak other languages too', () => {
    expect(looksEnglish('Le PR est prêt, merci pour la revue du code.')).toBe(false)
    expect(spokenShortFormsIfEnglish('Le PR est prêt, merci pour la revue du code.')).toBe('Le PR est prêt, merci pour la revue du code.')
    expect(spokenShortFormsIfEnglish('IDK, the PR is ready for a review.')).toBe("I don't know, the P R is ready for a review.")
  })
})

/**
 * Kokoro and Kitten read through espeak, which already says most initialisms right as written.
 * These run the real phonemizer: Kokoro's front end, and the one Kitten uses.
 */
describe.each([
  ['Kokoro', (text: string) => kokoroPhonemes(text, 'a')],
  ['Kitten', (text: string) => phonemizeKeepingPunctuation(text)]
])('short forms for espeak voices (%s)', (_voice, phonemes) => {
  const spoken = (text: string): Promise<string> => phonemes(spokenShortForms(text, { espeak: true }))

  it('keeps plurals and possessives as espeak says them, "pee-arz"', async () => {
    const text = "Two PRs and the PR's title."
    expect(await spoken(text)).toBe(await phonemes(text))
    expect(await spoken(text)).toContain('pˌiːˈɑːɹz')
  })

  it('says chat short forms as words', async () => {
    expect(await spoken('IDK, the PR is fine.')).toContain('aɪ dˈoʊnt nˈoʊ')
  })

  it('spells what espeak reads as a word, with the letter A said "ay"', async () => {
    expect(await phonemes('The ETA is ten minutes.')).toContain('ˈiːɾə')
    expect(await spoken('The ETA is ten minutes.')).toContain('ˈiː tˈiː ˈeɪ')
  })
})
