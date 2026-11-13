/*
 * Dev-only fixture: shows one seeded personal-bot conversation in the real renderer, for before/after screenshots of the
 * bot chat. It never ships (only out/** is packaged) and writes nothing: it swaps the renderer's bots client for one
 * that answers from the data below, so the daemon, bots.db and every provider are left alone.
 *
 * Use it in a development app (`npm run dev`, an isolated home under the worktree), the same way on master and on a
 * branch: open the app's DevTools (View > Toggle Developer Tools, undocked), paste this whole file into the Console and
 * press Enter. Then switch states with, for example:
 *
 *   await botSeed.show('free')
 *   await botSeed.show('typing')                    // the owner's "again", the typing bubble, work running
 *   await botSeed.show('allowed')                   // an answered ask, then typing
 *   await botSeed.show('oneTask')                   // one piece of work, using the browser
 *   await botSeed.show('taskPlusOne')               // one running, one queued
 *   await botSeed.show('paused')
 *   botSeed.scrollTo('report')                      // brings a message to the top: see botSeed.ids
 *
 * Options, kept between calls: `await botSeed.show('free', { localFile, localImage, localImages })` names a real text
 * file, a real PNG and up to four real pictures (PNG, JPEG, GIF or WebP) on this computer, so the Files pane and the
 * pictures have something to read: the markdown reply links `localFile` and `localImage`, the picture reply
 * (`botSeed.scrollTo('picture')`) shows `localImages[0]` alone, and the four-picture reply (`scrollTo('pictures')`) shows
 * all four in a carousel. For example `<worktree>/docs/plans/bot-ui.md`, `<worktree>/resources/icon.png`, and four of
 * `git ls-files '*.png' '*.jpg'`.
 *
 * The modules are reached by their dev-server URLs (the renderer's root is src/renderer), so this needs the dev app.
 */
(() => {
  const BOT = 'bot-8f8fe6503ab3'
  // A made-up profile folder: the shape of a real one, nothing of anyone's.
  const FILES = `C:\\Users\\me\\.mousse\\profiles\\d9d018ad-5de0-43be-9cb5-90253e174c2c\\bots\\files\\${BOT}`
  const today = (hours, minutes) => { const at = new Date(); at.setHours(hours, minutes, 0, 0); return at.toISOString() }
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()
  let options = {}

  const ids = {
    morning: 'seed-morning-1', drawAsk: 'seed-draw-ask', screenshot: 'seed-screenshot', compareAsk: 'seed-compare-ask',
    markdown: 'seed-markdown', commandAsk: 'seed-command-ask', handoff: 'seed-handoff', note: 'seed-note',
    noteReply: 'seed-note-reply', report: 'seed-report', browserAsk: 'seed-browser-ask', again: 'seed-again',
    pictureAsk: 'seed-picture-ask', picture: 'seed-picture', pictures: 'seed-pictures'
  }

  function conversation(scenario) {
    let seq = 0
    const owner = (id, at, text, extra = {}) => ({ seq: ++seq, id, at, author: 'owner', kind: 'text', text, chips: [], ...extra })
    const bot = (id, at, text, chips = [], extra = {}) => ({ seq: ++seq, id, at, author: 'bot', kind: 'text', text, chips, ...extra })
    const quote = (id, text) => ({ id, author: 'owner', text })
    const markdownFile = options.localFile ?? `${FILES}\\notes\\ssd-shortlist.md`
    const picture = options.localImage ?? `${FILES}\\ssd-prices.png`
    // Pictures it made: in its files folder, linked as the image tool's Markdown line is (`![…](<path>)`).
    const takes = [0, 1, 2, 3].map((at) => options.localImages?.[at] ?? options.localImage ?? `${FILES}\\images\\take-${at + 1}.png`)
    const image = (alt, path) => `![${alt}](<${path}>)`
    const rows = [
      // Three bot messages in a row, minutes apart: one group, a time on each.
      bot(ids.morning, today(9, 2), 'Morning! Your 9am is moved to 10.'),
      bot('seed-morning-2', today(9, 9), 'I also tidied the notes folder.'),
      bot('seed-morning-3', today(9, 14), 'Want the weekly summary?'),
      // The owner's screenshot: two Windows paths and three chips.
      owner(ids.drawAsk, today(21, 2), 'Draw a boy on a chip with clouds behind him, and save the picture and its drawing code.'),
      bot(ids.screenshot, today(21, 10), [
        'Here it is: the boy stands on the chip with clouds behind him, the way it looks right now.',
        '',
        '**Files:**',
        '',
        `- Picture (1600 × 1200): ${FILES}\\chip-clouds-boy.png`,
        `- Drawing code (opens in any browser): ${FILES}\\chip-clouds-boy.svg`,
        '',
        "I can change things like colours, the boy's pose or the note. I could also animate it, with data lights running along the wires, the flag waving and the light beams slowly glowing."
      ].join('\n'), [
        { icon: 'think', text: 'ran a command' },
        { icon: 'edit', text: 'saved 3 files', highlight: 'make.py +2' },
        { icon: 'read', text: 'read files', highlight: 'saved files' }
      ], { replyTo: quote(ids.drawAsk, 'Draw a boy on a chip with clouds behind him, and save the picture and its drawing code.') }),
      // Pictures: one alone as its own message, then four in a carousel.
      owner(ids.pictureAsk, today(21, 20), 'Make me a sticker of the boy, then three more takes on it.'),
      bot(ids.picture, today(21, 21), image('The boy, as a sticker', takes[0]), [{ icon: 'think', text: 'made a picture' }], { replyTo: quote(ids.pictureAsk, 'Make me a sticker of the boy, then three more takes on it.') }),
      bot(ids.pictures, today(21, 24), `Here are four takes. The second keeps the clouds closest to yours.\n\n${takes.map((path, at) => image(`Take ${at + 1}`, path)).join(' ')}`, [{ icon: 'think', text: 'made 4 pictures' }]),
      // A reply heavy with Markdown.
      owner(ids.compareAsk, today(21, 30), 'Compare three 2 TB SSDs for me, under £150.'),
      bot(ids.markdown, today(21, 31), [
        '## Three 2 TB SSDs under £150',
        '',
        'All three are **PCIe 4.0** and fit an M.2 slot. The shortlist is saved in `ssd-shortlist.md`:',
        '',
        markdownFile,
        '',
        '| Drive | Read | Price |',
        '|---|---|---|',
        '| Samsung 990 Pro | 7,450 MB/s | £139 |',
        '| WD Black SN850X | 7,300 MB/s | £129 |',
        '| Crucial T500 | 7,400 MB/s | £119 |',
        '',
        '1. **Best overall:** the 990 Pro.',
        '2. **Best value:** the T500.',
        '3. Skip anything without DRAM for a boot drive.',
        '',
        '> Prices change daily; I checked them at 21:30.',
        '',
        'To see the drive in Windows, run:',
        '',
        '```powershell',
        'Get-PhysicalDisk | Select-Object FriendlyName, MediaType, Size',
        '```',
        '',
        `Sources: [PC Part Picker](https://pcpartpicker.com/products/internal-hard-drive/). The price chart: ${picture}`
      ].join('\n'), [{ icon: 'search', text: 'searched the web', highlight: '3' }, { icon: 'web', text: 'read 4 pages', highlight: 'pcpartpicker.com +1' }], { replyTo: quote(ids.compareAsk, 'Compare three 2 TB SSDs for me, under £150.') }),
      // Work handed off ("on it"), then a note passed on to it.
      owner(ids.commandAsk, today(21, 50), 'run some command pls'),
      bot(ids.handoff, today(21, 50), "On it, I'll text you when it's done.", [{ icon: 'think', text: 'started', highlight: 'System check' }], { replyTo: quote(ids.commandAsk, 'run some command pls') }),
      owner(ids.note, today(21, 51), 'Use PC Part Picker for the prices too'),
      bot(ids.noteReply, today(21, 51), 'Your note is with it now.', [{ icon: 'think', text: 'passed on your note' }], { replyTo: quote(ids.note, 'Use PC Part Picker for the prices too') }),
      // The run report: it quotes the request; its facts are a list of keys and values.
      bot(ids.report, today(21, 53), [
        'Done. I ran a few commands that only read info, and nothing was changed.',
        '',
        '- **Computer name:** DESKTOP-01',
        '- **Windows:** Windows 11 Pro (build 26300)',
        '- **On for:** 2 days, 2 hours',
        '- **CPU:** AMD Ryzen 9 7900X, 12 cores and 24 threads',
        '- **RAM:** 19.7 GB free out of 63.6 GB',
        '- **C: drive:** 268.5 GB free out of 951.8 GB',
        '',
        'Want me to run something next? I could list the apps using the most memory, find your biggest folders, or check your network.'
      ].join('\n'), [{ icon: 'think', text: 'ran a command' }], { kind: 'run_report', activationId: 'seed-act-report', replyTo: quote(ids.commandAsk, 'run some command pls') }),
      // An ask: open, or answered in the "allowed" state.
      bot(ids.browserAsk, today(21, 56), "I've asked to use my own browser. Once you say yes, what should I start on?", [], {
        ask: { askId: 'seed-ask-browser', title: 'use the browser', note: 'Its own browser, apart from your tabs. Sites you sign in to for it stay signed in for it only.', status: scenario === 'allowed' ? 'allowed' : 'open' }
      })
    ]
    if (scenario === 'typing') rows.push(owner(ids.again, ago(0.2), 'again'))
    return rows
  }

  function summary(scenario) {
    const base = { id: BOT, name: 'alpha', description: 'Looks after my PC and finds me deals.', look: { colour: 'green', accessory: 'beret' }, state: 'idle', stateText: '', unread: 0, createdAt: today(8, 0), chat: undefined, work: [] }
    const running = (id, title, minutes) => ({ id, title, status: 'running', startedAt: ago(minutes) })
    switch (scenario) {
      case 'typing': return { ...base, state: 'working', stateText: 'Working on System check again', chat: { activationId: 'seed-act-chat' }, work: [running('seed-act-work-1', 'System check again', 0.3)] }
      case 'allowed': return { ...base, state: 'working', stateText: 'Working…', chat: { activationId: 'seed-act-chat' } }
      case 'oneTask': return { ...base, state: 'working', stateText: 'Working on SSD search', work: [running('seed-act-work-1', 'SSD search', 4)] }
      case 'taskPlusOne': return { ...base, state: 'working', stateText: 'Working on 2 things', work: [running('seed-act-work-1', 'SSD search', 4), { id: 'seed-act-work-2', title: 'Find biggest folders', status: 'queued', startedAt: ago(1) }] }
      case 'paused': return { ...base, state: 'paused', stateText: 'Paused until 14:00' }
      default: return base
    }
  }

  /** What each piece of running work is doing, as its live chip. */
  const ACTIVITY = { 'seed-act-work-1': { icon: 'web', text: 'using the browser', highlight: 'pcpartpicker.com', live: true } }

  let scenario = 'free'
  const client = {
    list: async () => [summary(scenario)],
    messages: async (botId, page = {}) => {
      const all = botId === BOT ? conversation(scenario) : []
      const before = page.beforeSeq === undefined ? all : all.filter((row) => row.seq < page.beforeSeq)
      return { messages: before.slice(-(page.limit ?? 50)) }
    },
    markRead: async () => undefined,
    get: async () => ({ summary: summary(scenario), permissions: [], runs: [] }),
    answer: async (botId, askId, answer) => conversation(scenario).find((row) => row.ask?.askId === askId) ?? null,
    stop: async () => undefined,
    stopWork: async () => undefined,
    send: async (botId, text, clientRequestId) => ({ seq: 999, id: `seed-sent-${clientRequestId}`, at: new Date().toISOString(), author: 'owner', kind: 'text', text, chips: [], clientRequestId })
  }
  const stub = new Proxy(client, { get: (target, key) => target[key] ?? (async () => { throw new Error(`${String(key)} is not in the bot chat seed`) }) })

  async function modules() {
    const [bots, chats] = await Promise.all([import('/stores/botsStore.ts'), import('/stores/chatsStore.ts')])
    return { bots, chats }
  }

  async function show(next = 'free', more = {}) {
    scenario = next
    options = { ...options, ...more }
    const { bots, chats } = await modules()
    bots.setBotsClient(stub)
    // Start the chat over, so the new state's rows are the only ones held.
    bots.useBotsStore.setState({ chats: {}, chatLoad: {}, pending: {}, activity: {}, live: {}, aboutOpen: false })
    await bots.useBotsStore.getState().refresh()
    await chats.useChatsStore.getState().openBot(BOT)
    const running = (summary(scenario).work ?? []).filter((item) => item.status === 'running').map((item) => item.id)
    bots.useBotsStore.setState({ activity: Object.fromEntries(running.filter((id) => ACTIVITY[id]).map((id) => [id, ACTIVITY[id]])) })
    return `showing ${scenario}`
  }

  function scrollTo(name) {
    const id = ids[name] ?? name
    document.querySelector(`.bot-conversation [data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' })
  }

  window.botSeed = { show, scrollTo, ids, files: FILES }
  return show('free')
})()
