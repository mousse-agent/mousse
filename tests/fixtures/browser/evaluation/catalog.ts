import type { BrowserObservation } from '../../../../src/shared/browser/types'
import { findElement, haystack } from './observations'
import type { GroundTruthCheck, TaskDefinition, VerifierInput } from './types'

function findNamed(observation: BrowserObservation, name: string, role?: string) {
  return findElement(observation, { name, role })
}

function textPresent(observation: BrowserObservation | undefined, snippet: string): boolean {
  return haystack(observation).includes(snippet)
}

function ok(notes: string[]): GroundTruthCheck {
  return { ok: true, falseSuccess: false, duplicateEffect: false, notes }
}

function fail(notes: string[], extra?: Partial<GroundTruthCheck>): GroundTruthCheck {
  return { ok: false, falseSuccess: extra?.falseSuccess ?? false, duplicateEffect: extra?.duplicateEffect ?? false, notes }
}

export function evaluationCatalog(): TaskDefinition[] {
  return [
    {
      id: 'forms.fill-save',
      category: 'forms',
      split: 'calibration',
      support: 'supported',
      page: '/form.html',
      goal: 'Fill Name with Ada and save.',
      repeatsDefault: 3,
      observationModes: ['structured', 'hybrid', 'screenshot'],
      expected: { text: 'saved:Ada:pwlen=0' },
      script: [
        { kind: 'act', action: (obs) => ({ type: 'fill', target: { kind: 'ref', ref: findNamed(obs, 'Name', 'textbox').ref }, text: 'Ada' }) },
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: findNamed(obs, 'Save', 'button').ref } }), expected: { type: 'text', text: 'saved:Ada', present: true } }
      ],
      verify: (input) => textPresent(input.observation, 'saved:Ada:pwlen=0') ? ok(['form saved']) : fail(['form did not save'])
    },
    {
      id: 'forms.submit-once',
      category: 'forms',
      split: 'calibration',
      support: 'supported',
      page: '/submit-once.html',
      goal: 'Submit exactly once.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      expected: { submitCount: 1 },
      script: [
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: findNamed(obs, 'Submit once').ref } }), expected: { type: 'text', text: 'submitted', present: true } }
      ],
      verify: (input) => {
        const count = input.submitCount('/submit-once')
        if (count > 1) return fail([`duplicate submit count ${count}`], { duplicateEffect: true })
        if (count !== 1) return fail([`expected one submit, got ${count}`])
        return ok(['exactly one submit'])
      }
    },
    {
      id: 'menus.dynamic',
      category: 'dynamic-menus',
      split: 'calibration',
      support: 'supported',
      page: '/menu.html',
      goal: 'Open the menu and choose Alpha.',
      repeatsDefault: 3,
      observationModes: ['structured', 'hybrid'],
      expected: { text: 'chose:alpha' },
      script: [
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: obs.elements.find((el) => (el.name ?? el.text ?? '').includes('Open menu'))!.ref } }) },
        { kind: 'wait', condition: { type: 'text', text: 'Alpha', present: true }, timeoutMs: 5_000 },
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: obs.elements.find((el) => (el.name ?? el.text ?? '') === 'Alpha' || (el.name ?? '').includes('Alpha'))!.ref } }), expected: { type: 'text', text: 'chose:alpha', present: true } }
      ],
      verify: (input) => textPresent(input.observation, 'chose:alpha') ? ok(['menu chose alpha']) : fail(['menu did not choose alpha'])
    },
    {
      id: 'navigation.basic',
      category: 'navigation',
      split: 'calibration',
      support: 'supported',
      page: '/nav-a.html',
      goal: 'Follow the link to page B.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      expected: { text: 'arrived-b' },
      script: [
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: obs.elements.find((el) => (el.name ?? el.text ?? '').includes('Go to B'))!.ref } }), expected: { type: 'text', text: 'arrived-b', present: true } }
      ],
      verify: (input) => textPresent(input.observation, 'arrived-b') ? ok(['navigated to B']) : fail(['did not reach page B'])
    },
    {
      id: 'navigation.race',
      category: 'navigation-races',
      split: 'held-out',
      support: 'supported',
      page: '/race.html',
      goal: 'Arm navigation and wait for page B.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      expected: { text: 'arrived-b' },
      script: [
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: obs.elements.find((el) => (el.name ?? el.text ?? '').includes('Arm navigation'))!.ref } }) },
        { kind: 'wait', condition: { type: 'url', includes: 'nav-b.html' }, timeoutMs: 8_000 }
      ],
      verify: (input) => (input.observation?.url.includes('nav-b.html') || textPresent(input.observation, 'arrived-b')) ? ok(['won navigation race']) : fail(['navigation race missed page B'])
    },
    {
      id: 'shadow.open',
      category: 'open-shadow',
      split: 'calibration',
      support: 'supported',
      page: '/shadow.html',
      goal: 'Fill the open shadow input and save.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      expected: { text: 'shadow-saved:shadow-ok' },
      script: [
        { kind: 'act', action: (obs) => ({ type: 'fill', target: { kind: 'ref', ref: findElement(obs, { name: 'Shadow', role: 'textbox' }).ref }, text: 'shadow-ok' }) },
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: findElement(obs, { name: 'Save shadow', role: 'button' }).ref } }), expected: { type: 'text', text: 'shadow-saved:shadow-ok', present: true } }
      ],
      verify: (input) => textPresent(input.observation, 'shadow-saved:shadow-ok') ? ok(['open shadow saved']) : fail(['open shadow did not save'])
    },
    {
      id: 'frames.cross-origin',
      category: 'frames',
      split: 'held-out',
      support: 'supported',
      page: '/frame-parent.html',
      goal: 'Fill the cross-origin frame and submit.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      expected: { text: 'frame-saved:frame-ok' },
      script: [
        { kind: 'act', action: (obs) => ({ type: 'fill', target: { kind: 'ref', ref: obs.elements.find((el) => (el.name ?? '').includes('Duplicate') && el.role === 'textbox')!.ref }, text: 'frame-ok' }) },
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: obs.elements.find((el) => (el.name ?? el.text ?? '').includes('Submit frame'))!.ref } }), expected: { type: 'text', text: 'frame-saved:frame-ok', present: true } }
      ],
      verify: (input) => {
        if (input.frameSubmitCount !== 1) return fail([`frame submit count ${input.frameSubmitCount}`], { duplicateEffect: input.frameSubmitCount > 1 })
        return textPresent(input.observation, 'frame-saved:frame-ok') ? ok(['frame saved']) : fail(['frame did not save'])
      }
    },
    {
      id: 'files.upload',
      category: 'upload-download',
      split: 'calibration',
      support: 'supported',
      page: '/upload.html',
      goal: 'Upload the staged note.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      script: [
        { kind: 'upload', query: { name: 'Files' }, artifactIds: ['staged'] }
      ],
      verify: (input) => textPresent(input.observation, 'note.txt') ? ok(['upload selected note.txt']) : fail(['upload did not select note.txt'])
    },
    {
      id: 'files.download',
      category: 'upload-download',
      split: 'held-out',
      support: 'supported',
      page: '/download.html',
      goal: 'Download the fixture attachment.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      script: [
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: findElement(obs, { name: 'Download fixture', role: 'button' }).ref } }) }
      ],
      verify: (input) => input.downloadNames.includes('fixture-download.txt') ? ok(['download published']) : fail([`downloads: ${input.downloadNames.join(',')}`])
    },
    {
      id: 'control.takeover',
      category: 'takeover',
      split: 'held-out',
      support: 'supported',
      page: '/form.html',
      goal: 'Fence agent input during human takeover, then resume with fresh refs and save.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      expected: { text: 'saved:Ada:pwlen=0' },
      script: [
        { kind: 'takeover', owner: 'human' },
        { kind: 'human-act-expect-block', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: findNamed(obs, 'Save', 'button').ref } }) },
        { kind: 'takeover', owner: 'agent' },
        { kind: 'observe' },
        { kind: 'act', action: (obs) => ({ type: 'fill', target: { kind: 'ref', ref: findNamed(obs, 'Name', 'textbox').ref }, text: 'Ada' }) },
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: findNamed(obs, 'Save', 'button').ref } }), expected: { type: 'text', text: 'saved:Ada', present: true } }
      ],
      verify: (input) => {
        const blocked = input.actionOutcomes.some((action) => action.outcome === 'blocked' || action.code === 'human_controlled' || action.code === 'stale_generation')
        if (!blocked) return fail(['takeover did not block the agent action'])
        return textPresent(input.observation, 'saved:Ada:pwlen=0') ? ok(['takeover then resume saved']) : fail(['resume did not save'])
      }
    },
    {
      id: 'recovery.stale-no-replay',
      category: 'recovery',
      split: 'held-out',
      support: 'supported',
      page: '/submit-once.html',
      goal: 'After a successful submit, refuse to replay the stale action and keep a single effect.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      script: [
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: findNamed(obs, 'Submit once').ref } }), expected: { type: 'text', text: 'submitted', present: true } },
        { kind: 'replay-stale' }
      ],
      verify: (input) => {
        const count = input.submitCount('/submit-once')
        const stale = input.actionOutcomes.some((action) => action.code === 'stale_ref' || action.code === 'stale_observation' || action.code === 'stale_generation' || action.outcome === 'tool-error')
        if (count > 1) return fail([`replay duplicated submit (${count})`], { duplicateEffect: true })
        if (count !== 1 || !stale) return fail([`submit=${count} staleReject=${stale}`])
        return ok(['stale replay refused; one submit'])
      }
    },
    {
      id: 'lists.virtualized',
      category: 'virtualized',
      split: 'held-out',
      support: 'supported',
      page: '/virtualized.html',
      goal: 'Scroll the list and pick item 12.',
      repeatsDefault: 3,
      observationModes: ['structured'],
      expected: { text: 'picked:12' },
      script: [
        // Wheel events must be delivered over the scroll container. A page
        // scroll leaves the virtualized list at its initial window.
        { kind: 'act', action: (obs) => ({ type: 'scroll', target: { kind: 'ref', ref: findElement(obs, { role: 'list' }).ref }, deltaX: 0, deltaY: 280 }) },
        { kind: 'wait', condition: { type: 'text', text: 'Item 12', present: true }, timeoutMs: 5_000 },
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: obs.elements.find((el) => (el.name ?? el.text ?? '').includes('Item 12'))!.ref } }), expected: { type: 'text', text: 'picked:12', present: true } }
      ],
      verify: (input) => textPresent(input.observation, 'picked:12') ? ok(['picked virtualized item 12']) : fail(['did not pick item 12'])
    },
    {
      id: 'unsupported.closed-shadow',
      category: 'closed-shadow',
      split: 'held-out',
      support: 'unsupported',
      page: '/closed-shadow.html',
      goal: 'Do not fabricate a ref into closed shadow DOM.',
      repeatsDefault: 1,
      observationModes: ['structured'],
      script: [],
      verify: (input) => {
        if (textPresent(input.observation, 'page-leaked')) return fail(['closed shadow was activated'], { falseSuccess: true })
        return ok(['closed shadow is an explicit unsupported case; the executor did not claim a supported widget path'])
      }
    },
    {
      id: 'unsupported.canvas',
      category: 'canvas',
      split: 'held-out',
      support: 'unsupported',
      page: '/canvas.html',
      goal: 'Do not fabricate a DOM ref for a painted canvas widget.',
      repeatsDefault: 1,
      observationModes: ['structured'],
      script: [],
      verify: (input) => {
        const clicked = textPresent(input.observation, 'canvas-clicked')
        if (clicked) return fail(['canvas was clicked without a certified vision path'], { falseSuccess: true })
        return ok(['canvas left idle; structured executor did not invent a widget ref'])
      }
    },
    {
      id: 'unsupported.overlay',
      category: 'overlays',
      split: 'calibration',
      support: 'unsupported',
      page: '/overlay.html',
      goal: 'Refuse to force-click through a blocking overlay.',
      repeatsDefault: 1,
      observationModes: ['structured'],
      script: [
        { kind: 'act', action: (obs) => ({ type: 'click', target: { kind: 'ref', ref: obs.elements.find((el) => (el.name ?? el.text ?? '').includes('Submit'))!.ref } }) }
      ],
      verify: (input) => {
        if (textPresent(input.observation, 'clicked')) return fail(['overlay click reached the page'], { falseSuccess: true })
        const blocked = input.actionOutcomes.some((action) => action.code === 'not_actionable')
        return blocked ? ok(['overlay click refused']) : fail(['overlay click was not reported not_actionable'])
      }
    }
  ]
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6D2B79F5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}
