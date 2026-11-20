import { describe, expect, it } from 'vitest'
import { spokenShortForms } from '../src/renderer/readAloud/shortForms'

describe('spokenShortForms', () => {
  it.each([
    // Chat short forms are said as words, in any letter case.
    ['IDK, maybe later.', "I don't know, maybe later."],
    ['idk tbh', "I don't know to be honest"],
    ['TL;DR: it works.', 'T L D R: it works.'],
    // Capital initialisms without a vowel are spelled by rule, plurals and possessives too.
    ['The PR is open.', 'The P R is open.'],
    ['Two PRs and the PR’s title.', 'Two P R s and the P R’s title.'],
    ['Run it in WSL over RPC.', 'Run it in W S L over R P C.'],
    // Initialisms with a vowel are spelled only when listed.
    ['The CLI and the UI.', 'The C L I and the U I.'],
    // Latin and symbol short forms; "etc." keeps its period at a sentence end.
    ['Fruit, e.g. apples, etc. Then more.', 'Fruit, for example apples, et cetera. Then more.'],
    ['Apples, pears, etc. are fine.', 'Apples, pears, et cetera are fine.'],
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
    // Mixed case, inside longer words, and names that only look like short forms.
    'SQLite, iOS, MCPServer, PR_NUMBER, the nvm tool, Ms. Smith.'
  ])('leaves %j for the voice to say as written', (text) => {
    expect(spokenShortForms(text)).toBe(text)
  })

  it('writes the letter A as "eh" for voices that read through espeak, which says a lone A as "uh"', () => {
    expect(spokenShortForms('The API and the FAQ.')).toBe('The A P I and the F A Q.')
    expect(spokenShortForms('The API and the FAQ.', { espeak: true })).toBe('The eh P I and the F eh Q.')
  })
})
