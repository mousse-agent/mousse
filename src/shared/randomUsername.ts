const ADJECTIVES = [
  'Cosmic',
  'Velvet',
  'Neon',
  'Sleepy',
  'Turbo',
  'Misty',
  'Golden',
  'Pixel',
  'Wobbly',
  'Silent',
  'Brave',
  'Fuzzy',
  'Electric',
  'Lucky',
  'Midnight',
  'Sunny',
  'Rusty',
  'Clever',
  'Dapper',
  'Spicy'
]

const NOUNS = [
  'Waffle',
  'Badger',
  'Comet',
  'Penguin',
  'Noodle',
  'Phoenix',
  'Otter',
  'Rocket',
  'Mango',
  'Wizard',
  'Fox',
  'Panda',
  'Cactus',
  'Bison',
  'Kraken',
  'Pickle',
  'Falcon',
  'Gizmo',
  'Llama',
  'Sprout'
]

export function generateRandomUsername(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!
  return `${adj} ${noun}`
}
