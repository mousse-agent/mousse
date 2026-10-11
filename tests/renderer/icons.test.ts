import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import * as icons from '../../src/renderer/lib/icons'

it('renders every migrated icon through the installed free Hugeicons renderer', () => {
  for (const [name, Icon] of Object.entries(icons)) {
    const markup = renderToStaticMarkup(createElement(Icon))
    expect(markup, name).toContain('data-icon-library="hugeicons"')
    expect(markup, name).toContain('viewBox="0 0 24 24"')
    expect(markup, name).toContain('width="16"')
    expect(markup, name).toMatch(/<(?:path|rect|circle|ellipse|line|polyline|polygon)\b/)
    expect(markup, name).not.toContain('undefined')
    expect(markup, name).not.toContain('NaN')
  }
})

it('preserves compact sizes, stroke props, styling and accessible caller labels', () => {
  const markup = renderToStaticMarkup(createElement(icons.House, {
    size: 18, strokeWidth: 1.8, className: 'active', color: 'currentColor', 'aria-label': 'Home'
  }))
  expect(markup).toContain('width="18"')
  expect(markup).toContain('height="18"')
  expect(markup).toContain('stroke-width="1.8"')
  expect(markup).toContain('class="mousse-icon active"')
  expect(markup).toContain('aria-label="Home"')
  expect(markup).not.toContain('aria-hidden="true"')
  const tablerMarkup = renderToStaticMarkup(createElement(icons.IconCheck, { stroke: 1.25, size: 14 }))
  expect(tablerMarkup).toContain('stroke-width="1.25"')
  expect(tablerMarkup).toContain('width="14"')
})
