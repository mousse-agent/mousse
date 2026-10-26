import { describe, expect, it } from 'vitest'
import { numberToWords, ordinalWords, spokenEnglish } from '../src/renderer/readAloud/spokenEnglish'

describe('numberToWords', () => {
  it.each([
    [0, 'zero'],
    [7, 'seven'],
    [19, 'nineteen'],
    [42, 'forty-two'],
    [100, 'one hundred'],
    [1000, 'one thousand'],
    [1200, 'twelve hundred'],
    [2026, 'two thousand twenty-six'],
    [2500, 'two thousand five hundred'],
    [1_000_000, 'one million'],
    [-42, 'negative forty-two'],
    [999_999_999, 'nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine']
  ])('%d is %s', (value, words) => {
    expect(numberToWords(value)).toBe(words)
  })

  it('reads numbers beyond a trillion digit by digit', () => {
    expect(numberToWords(1e15)).toBe('one zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero')
  })
})

describe('ordinalWords', () => {
  it.each([
    [1, 'first'],
    [2, 'second'],
    [5, 'fifth'],
    [12, 'twelfth'],
    [20, 'twentieth'],
    [21, 'twenty-first'],
    [100, 'one hundredth'],
    [103, 'one hundred third']
  ])('%d is %s', (value, words) => {
    expect(ordinalWords(value)).toBe(words)
  })
})

describe('spokenEnglish', () => {
  it.each([
    ['There are 1200 students', 'There are twelve hundred students'],
    ['Pi is 3.14', 'Pi is three point one four'],
    ['1.50 volts', 'one point five zero volts'],
    ['It is -5 outside', 'It is negative five outside'],
    ['Add .5 cup', 'Add zero point five cup'],
    ['7,900,000 people', 'seven million nine hundred thousand people'],
    ['pick 1, 2, 3', 'pick one, two, three'],
    ['$4.99 today', 'four dollars and ninety-nine cents today'],
    ['$1 only', 'one dollar only'],
    ['$85K a year', 'eighty-five thousand dollars a year'],
    ['€1,200 rent', 'twelve hundred euros rent'],
    ['50% off', 'fifty percent off'],
    ['3.5% growth', 'three point five percent growth'],
    ['at 3:30pm', 'at three thirty pm'],
    ['at 9:05 AM', 'at nine oh five am'],
    ['at 14:00', 'at fourteen hundred'],
    ['the 21st century', 'the twenty-first century'],
    ['1/2 cup and 3/4 mile', 'one half cup and three quarters mile'],
    ['2/3 done', 'two thirds done'],
    ['the 1990s and the 80s', 'the nineteen nineties and the eighties'],
    ['pages 10-20', 'pages ten to twenty'],
    ['call 555-1234', 'call five five five one two three four'],
    ['host 192.168.1.1', 'host one nine two dot one six eight dot one dot one'],
    ['GPT-3.5 and gpt-4', 'GPT three point five and gpt four'],
    ['a 7B model', 'a seven billion model'],
    ['25°C and 100km', 'twenty-five degrees Celsius and one hundred kilometers'],
    ['rate 1e-4', 'rate one times ten to the negative four']
  ])('%s', (input, expected) => {
    expect(spokenEnglish(input)).toBe(expected)
  })

  it('leaves words, punctuation and abbreviations alone', () => {
    const text = 'Dr. Smith said, "wait... really?" e.g. the U.S. case.'
    expect(spokenEnglish(text)).toBe(text)
  })
})
