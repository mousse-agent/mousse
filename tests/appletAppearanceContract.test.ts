import { expect, it } from 'vitest'
import { validateAppletAppearance } from '../src/shared/appletAppearance'
const appearance = {
  theme: 'dark',
  colorScheme: 'dark',
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  fontSize: '14px',
  reducedMotion: false,
  tokens: { '--accent': '#ac86ce', '--bg-primary': '#1b1c23' }
}
it('keeps only visual whitelist values and excludes acrylic and private settings', () => {
  expect(
    validateAppletAppearance({
      ...appearance,
      apiKey: 'private',
      tokens: {
        ...appearance.tokens,
        '--glass-blur': 'blur(20px)',
        '--acrylic-intensity': '80',
        '--private-home': '/secret'
      }
    })
  ).toEqual(appearance)
})
it('rejects style markup and external resources at the appearance boundary', () => {
  for (const value of [
    'red;--new:blue',
    '</style><script>bad()</script>',
    'url(https://example.test/a)',
    'red\n'
  ]) {
    expect(() =>
      validateAppletAppearance({ ...appearance, tokens: { '--accent': value } })
    ).toThrow()
  }
  expect(() =>
    validateAppletAppearance({ ...appearance, fontFamily: 'system-ui; background:red' })
  ).toThrow()
})
it('accepts resolved gradients, shadows, control dimensions and reduced motion', () => {
  const value = {
    ...appearance,
    reducedMotion: true,
    tokens: {
      '--gradient-accent': 'linear-gradient(120deg, #ac86ce, #7b5b91)',
      '--ui-specular': 'inset 0 1px 0 rgba(255,255,255,0.16)',
      '--theme-btn-padding': '5px 12px'
    }
  }
  expect(validateAppletAppearance(value)).toEqual(value)
})
