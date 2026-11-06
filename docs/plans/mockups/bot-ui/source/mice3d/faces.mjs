// The mice the mockups use, and which strips to bake. node faces.mjs > jobs.json
// A bot's look is { colour, acc }: a body colour and one accessory (mice.html, ACCS). Mockup states map to the mouse's feelings.
export const LOOKS = {
  inbox: { colour: 'coral', acc: 1 },
  prs: { colour: 'blue', acc: 2 },
  garden: { colour: 'green', acc: 6 },
  flights: { colour: 'teal', acc: 4 }
}
export const SIDE = [['Standup notes', 'working', 'orange', 5], ['Recipes', 'idle', 'yellow', 10], ['Invoices', 'waiting', 'purple', 8], ['Gym coach', 'idle', 'pink', 6], ['Travel', 'paused', 'teal', 3], ['Bug triage', 'blocked', 'green', 11], ['Budget', 'done', 'yellow', 7], ['Spanish tutor', 'idle', 'coral', 9]]
export const FEEL = { idle: 'idle', working: 'working', waiting: 'waiting', blocked: 'blocked', paused: 'sleeping', done: 'happy' }

if (import.meta.url === `file://${process.argv[1]}`) {
  const jobs = []
  const chat = { inbox: ['idle', 'working', 'waiting', 'blocked', 'done'], prs: ['idle', 'working'], garden: ['idle'], flights: ['idle', 'paused'] }
  // Avatars (28–48 px) show the head; the larger About and empty-page faces show the whole mouse.
  for (const [bot, states] of Object.entries(chat)) for (const state of states) jobs.push({ id: `${bot}-${state}`, ...LOOKS[bot], state, px: 96, view: 'head' })
  jobs.push({ id: 'inbox-done-l', ...LOOKS.inbox, state: 'done', px: 176, view: 'full' })
  jobs.push({ id: 'inbox-idle-xl', ...LOOKS.inbox, state: 'idle', px: 208, view: 'full' })
  for (let acc = 0; acc < 12; acc++) jobs.push({ id: `pick-${acc}`, colour: 'coral', acc, state: 'idle', px: 88, view: 'head', still: true })
  SIDE.forEach(([, state, colour, acc], i) => jobs.push({ id: `side-${i}`, colour, acc, state, px: 96, view: 'head' }))
  console.log(JSON.stringify(jobs))
}
