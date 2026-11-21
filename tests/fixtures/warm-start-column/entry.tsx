import { getDefaultSettings } from '../../../src/shared/settings'
import type { WarmStartView } from '../../../src/shared/warmStart'

// The real window's code (main.tsx, App, the warm chat and the real chat) with the bridge stubbed: the warm start is
// handed over synchronously, and the service answers only when the test says so (`qa.bind()`).
const T = '2026-11-20T10:00:00.000Z'
const profile = { id: 'prf_column', displayName: 'Work', color: '#336699', status: 'active', revision: 1, isDefault: true }
const appearance = { ...getDefaultSettings().appearance, theme: 'github-dark' as const, acrylic: false }
const thread = { id: 't-open', name: 'Measure turn checkpoint time and disk', createdAt: T, updatedAt: T, startedAt: T, order: 0 }
const prose = 'Last week the project recorded about 125 to 185 end-of-turn checkpoints a day, and about half of them delay the agent\'s first response by a little; this is an estimate from replaying the commands, and the real step also writes the snapshot index, so it costs a little more than the replay shows.'
const table = [
  '| What | Size | Notes |',
  '| --- | --- | --- |',
  '| Private snapshot indexes (2 per worktree × 208 worktrees) | ≈ 224 MB | Almost all of the disk used |',
  '| Snapshot data kept only by the app\'s refs (4,044 refs) | 1.75 MiB | Shared with the branches |',
  '| Old snapshot leftovers waiting for Git cleanup | under 1 MiB | Removed by the next cleanup |'
].join('\n')
const say = (id: string, role: 'user' | 'assistant', content: string) => ({ id, role, content, timestamp: T })
const messages = [
  say('m1', 'user', 'How much time and disk do the turn checkpoints take?'),
  say('m2', 'assistant', `${prose}\n\n**Disk: about 225 MB, almost all of it in the private index files.**\n\n${table}\n\n${prose}`),
  say('m3', 'user', 'And per worktree?'),
  say('m4', 'assistant', `${prose}\n\n${table}`)
]
const view: WarmStartView = { profileId: profile.id, profile: profile as never, threads: [thread] as never, projects: [], activeThreadId: thread.id, messages: messages as never }

const errors: string[] = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const listeners = new Map<string, Set<(...args: any[]) => void>>()
const emit = (method: string, ...args: unknown[]) => { for (const listener of listeners.get(method) ?? []) listener(...args) }
let bind!: () => void
const bound = new Promise<void>(done => { bind = done })
// Never settles: what the window asks beyond the startup it shows is not this test's.
const never = new Promise<never>(() => {})
const settings = { ...getDefaultSettings(), appearance }
const answers: Record<string, (...args: any[]) => unknown> = {
  'app.warmStartView': () => view,
  'window.isMaximized': () => Promise.resolve(false),
  'profiles.list': () => bound.then(() => ({ defaultProfileId: profile.id, profiles: [profile] })),
  'profiles.status': () => bound.then(() => ({ binding: { profileId: profile.id, epoch: 1 } })),
  'threads.initialize': () => new Promise<void>(done => setTimeout(() => {
    emit('projects.onUpdated', [])
    emit('threads.onUpdated', [thread], { epoch: 'service', seq: 1, generation: 1 })
    emit('threads.onSelected', { id: thread.id })
    emit('threads.onView', { threadId: thread.id, messages, agents: [], tasks: [] })
    done()
  }, 50)),
  'threads.getActivity': () => Promise.resolve({}),
  'turn.getSnapshot': () => Promise.resolve({}),
  'threads.get': () => Promise.resolve(thread),
  'threads.select': () => Promise.resolve(),
  'settings.get': () => Promise.resolve(settings),
  'settings.getOptions': () => Promise.resolve({ themes: [], accentColors: [], agentTypes: [], llmProviders: [{ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }] }] }),
  'skills.list': () => Promise.resolve({ skills: [] }),
  'orchestrator.isTurnActive': () => Promise.resolve(false),
  'queue.list': () => Promise.resolve([]),
  'app.getInfo': () => Promise.resolve({ platform: 'win32', repoRoot: '', llmProvider: 'claude-subscription' })
}

function api(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      if (path.length === 0 && key === 'platform') return 'win32'
      if (path.length === 0 && key === 'startupAppearance') return appearance
      if (key === 'then') return undefined
      return api([...path, String(key)])
    },
    apply(_target, _this, args) {
      const method = path.join('.')
      // A subscription (`onX(listener)`) gets back the function that removes it, as the preload does.
      if (path.at(-1)?.startsWith('on') || typeof args[0] === 'function') {
        const subscriptions = listeners.get(method) ?? new Set()
        listeners.set(method, subscriptions)
        subscriptions.add(args[0])
        return () => subscriptions.delete(args[0])
      }
      return (answers[method] ?? (() => never))(...args)
    }
  })
}
;(window as any).mousse = api()

/** The transcript as one frame lays it out: its column, the composer's, and where each turn and the table sit. */
type Frame = { fonts: string; warm: boolean; column: number[]; composer: number[] | null; turns: number[]; table: number[] | null; text: number }
const frames: Frame[] = []
const rect = (element: Element | null | undefined) => {
  if (!element) return null
  const box = element.getBoundingClientRect()
  return [box.left, box.top, box.width, box.height].map(value => Math.round(value * 10) / 10)
}
let sampling = true
function sample() {
  const chat = document.querySelector('[data-mousse="chat"]')
  const list = chat?.querySelector('.an-message-list')
  if (chat && list?.querySelector('[data-turn-key]')) {
    frames.push({
      fonts: document.fonts.status,
      warm: chat.hasAttribute('data-warm-start'),
      column: rect(list.firstElementChild)!,
      composer: rect(chat.querySelector('.chat-input-area')),
      turns: [...list.querySelectorAll('[data-turn-key]')].map(turn => Math.round(turn.getBoundingClientRect().top * 10) / 10),
      table: rect(list.querySelector('table')),
      text: (list.textContent ?? '').length
    })
  }
  if (sampling) requestAnimationFrame(sample)
}
requestAnimationFrame(sample)

;(window as any).qa = {
  bind: () => bind(),
  live: () => Boolean(document.querySelector('[data-mousse="chat"]:not([data-warm-start]) .an-message-list [data-turn-key]')),
  warm: () => Boolean(document.querySelector('[data-warm-start] .an-message-list [data-turn-key]')),
  stop: () => { sampling = false; return { frames, errors } }
}
void import('../../../src/renderer/main')
