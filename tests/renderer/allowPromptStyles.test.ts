// @vitest-environment jsdom
/**
 * The Allow prompt shows app-wide (outside the Settings dialogs) as well as inside Let a device in. Its Not now and
 * Allow buttons keep the same gap in both places, from the rules in the Devices stylesheet.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AllowPrompt } from '../../src/renderer/components/netEngine/AllowPrompt'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/components/netEngine/engine.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

/** The `gap` the stylesheet gives `element`, the last matching rule winning. */
function gapOf(element: Element): string | undefined {
  let gap: string | undefined
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!element.matches(match[1].trim())) continue
    const declared = /(?:^|;)\s*gap\s*:\s*([^;]+)/.exec(match[2])
    if (declared) gap = declared[1].trim()
  }
  return gap
}

function actionsIn(wrapper: string | null): Element {
  const prompt = renderToStaticMarkup(createElement(AllowPrompt, { approval: { name: 'Studio' }, busy: false, onAnswer: () => {} }))
  document.body.innerHTML = wrapper ? `<div class="${wrapper}">${prompt}</div>` : prompt
  const actions = document.querySelector('.engine-allow .devices-dialog-actions')
  if (!actions) throw new Error('no actions row in the Allow prompt')
  expect([...actions.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Not now', 'Allow'])
  return actions
}

describe('Allow prompt buttons', () => {
  it('keep the Settings dialog gap when the prompt shows on its own, app-wide', () => {
    const inDialog = gapOf(actionsIn('engine-dialog'))
    expect(inDialog).toBe('var(--space-8)')
    expect(gapOf(actionsIn(null))).toBe(inDialog)
  })
})
