const query = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
const profileKey = () => new URLSearchParams(location.search).get('profile') || 'default'
const key = (name: string) => `mousse-profile-${profileKey()}-${name}`
const profile = profileKey()
const profileId = query('#profile-id')
const draft = query<HTMLInputElement>('#draft')
const dirtyState = query('#dirty-state')
const eventLog = query('#event-log')
const setDirty = (dirty: boolean) => {
  dirtyState.dataset.dirty = String(dirty)
  dirtyState.textContent = dirty ? 'dirty' : 'clean'
}
const render = () => {
  profileId.textContent = profile
  draft.value = localStorage.getItem(key('draft')) || ''
  document.documentElement.dataset.theme = localStorage.getItem(key('theme')) || 'dark'
  query('#partition-marker').textContent = localStorage.getItem(key('partition')) || 'empty'
}
const log = (message: string) => { eventLog.textContent = `${eventLog.textContent}\n${message}`.trim() }
render()
localStorage.setItem(key('partition'), profile)
render()
draft.addEventListener('input', () => setDirty(true))
query('[data-action="save"]').addEventListener('click', () => {
  localStorage.setItem(key('draft'), draft.value)
  setDirty(false)
})
query('[data-action="theme"]').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  localStorage.setItem(key('theme'), next)
})
for (const target of ['a', 'b']) query(`[data-action="switch-${target}"]`).addEventListener('click', () => {
  if (dirtyState.dataset.dirty === 'true') {
    log('dirty-guard')
    return
  }
  location.search = `?profile=profile-${target}`
})
// This listener models the production window event bridge: events are accepted
// only when their trusted profile matches this window's binding.
window.addEventListener('mousse-profile-event', (event) => {
  const detail = (event as CustomEvent<{ profileId: string; message: string }>).detail
  if (detail.profileId === profile) log(detail.message)
})
window.addEventListener('mousse-late-response', (event) => {
  const detail = (event as CustomEvent<{ profileId: string; message: string }>).detail
  if (detail.profileId === profile) log(detail.message)
})
