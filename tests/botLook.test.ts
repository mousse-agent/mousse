import { describe, expect, it } from 'vitest'
import { BOT_ACCESSORIES, BOT_COLOURS, normalizeBotLook, pickDistinctLook, type BotLook } from '../src/shared/bots/personal/look'

describe('bot looks', () => {
  it('reads unknown or missing values as coral and no accessory', () => {
    expect(normalizeBotLook(undefined)).toEqual({ colour: 'coral', accessory: 'none' })
    expect(normalizeBotLook({})).toEqual({ colour: 'coral', accessory: 'none' })
    expect(normalizeBotLook({ colour: 'mauve', accessory: 'monocle' })).toEqual({ colour: 'coral', accessory: 'none' })
    expect(normalizeBotLook({ colour: 'teal', accessory: 'monocle' })).toEqual({ colour: 'teal', accessory: 'none' })
    expect(normalizeBotLook({ colour: 'teal', accessory: 'chef_hat' })).toEqual({ colour: 'teal', accessory: 'chef_hat' })
  })

  it('keeps the accessory order of the face shader', () => {
    expect(BOT_ACCESSORIES.indexOf('none')).toBe(0)
    expect(BOT_ACCESSORIES.indexOf('crown')).toBe(7)
    expect(BOT_ACCESSORIES.indexOf('hood')).toBe(11)
    expect(BOT_ACCESSORIES).toHaveLength(12)
    expect(BOT_COLOURS).toHaveLength(8)
  })

  it('picks the least-used accessory, then the least-used colour', () => {
    const existing: BotLook[] = BOT_ACCESSORIES.filter((accessory) => accessory !== 'scarf').map((accessory) => ({ colour: 'coral', accessory }))
    const picked = pickDistinctLook(existing, () => 0)
    expect(picked.accessory).toBe('scarf')
    expect(picked.colour).not.toBe('coral')
  })

  it('breaks ties with the random source', () => {
    expect(pickDistinctLook([], () => 0)).toEqual({ colour: BOT_COLOURS[0], accessory: BOT_ACCESSORIES[0] })
    expect(pickDistinctLook([], () => 0.999)).toEqual({ colour: BOT_COLOURS[7], accessory: BOT_ACCESSORIES[11] })
  })

  it('never repeats a look while one of the 96 is free', () => {
    const looks: BotLook[] = []
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < BOT_COLOURS.length * BOT_ACCESSORIES.length; i++) looks.push(pickDistinctLook(looks, random))
    expect(new Set(looks.map((look) => `${look.colour}/${look.accessory}`)).size).toBe(96)
  })

  it('counts unknown stored looks as the default', () => {
    const picked = pickDistinctLook([{ colour: 'mauve', accessory: 'monocle' }], () => 0)
    expect(picked.accessory).toBe('headphones')
  })
})
