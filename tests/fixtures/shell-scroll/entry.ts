// The app's frame around a bot chat with About open (Runs on at the panel's end), each frame box holding content past
// the window's bottom and right edge: something a scroll could reveal.
import { centerWithin, keepShellUnscrolled } from '../../../src/renderer/lib/shellScroll'

keepShellUnscrolled()
const past = '<div style="position:relative;flex:0 0 0;width:0;height:0"><div style="position:absolute;left:1600px;top:2400px;width:10px;height:10px"></div></div>'
document.getElementById('root')!.innerHTML = `
<div class="app">${past}<div class="app-content">${past}
  <div class="app-workspace" style="display:flex;flex:1;min-width:0;min-height:0">
    <main class="main-area" style="flex:0 0 0">${past}</main>
    <div class="keep-mounted-pane">${past}<main class="chat-workspace">
      <section class="chat-conversation"><div class="chat-transcript"><p>Hello</p></div></section>
      <aside class="bot-about" style="width:300px"><div class="bot-about-scroll"><div style="height:1400px"></div><div id="bot-about-runs-on" style="height:80px"><button id="pick">Model</button></div></div></aside>
    </main></div>
  </div>
</div></div>`
// Outside the frame: an overflow: hidden box, which Chromium scrolls for scrollIntoView.
const control = document.createElement('div')
control.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;overflow:hidden'
control.innerHTML = '<div style="height:1000px"></div><div id="control-target" style="height:20px"></div>'
document.body.append(control)

const FRAME = ['body', '#root', '.app', '.app-content', '.main-area', '.keep-mounted-pane']
const box = (selector: string) => document.querySelector(selector)!
// The panel's own scroller (BotAboutPanel.tsx), inside the aside that holds its resize edge.
const panel = () => box('.bot-about-scroll')
const target = () => box('#bot-about-runs-on')
const frames = (count: number) => new Promise<void>((done) => {
  const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : done())
  step(count)
})
const offsets = () => Object.fromEntries([['page', document.scrollingElement!] as const, ...FRAME.map((selector) => [selector, box(selector)] as const)]
  .map(([name, element]) => [name, { top: element.scrollTop, left: element.scrollLeft }]))
const reset = async () => { panel().scrollTop = 0; await frames(3) }

Object.assign(window, { qa: {
  // Each frame box and the page told to scroll outright.
  async assign() {
    for (const element of [document.scrollingElement!, ...FRAME.map(box)]) { element.scrollTop = 300; element.scrollLeft = 300 }
    window.scrollTo(300, 300)
    await frames(3)
    return { shell: offsets() }
  },
  // The call "Pick a model" made before: scrollIntoView, which scrolls every box around the row.
  async scrollIntoView() { await reset(); target().scrollIntoView({ block: 'center' }); await frames(3); return { shell: offsets(), panel: panel().scrollTop } },
  // Focus without preventScroll scrolls the same way.
  async focus() { await reset(); (box('#pick') as HTMLElement).focus(); await frames(3); return { shell: offsets(), panel: panel().scrollTop } },
  // What it calls now: the panel alone.
  async centerWithin() {
    await reset()
    centerWithin(panel(), target())
    await frames(3)
    return { shell: offsets(), panel: panel().scrollTop, panelMax: panel().scrollHeight - panel().clientHeight }
  },
  // A theme that sets the frame back to overflow: hidden: it can scroll again, and is put back.
  async hiddenFrame() {
    for (const selector of FRAME) (box(selector) as HTMLElement).style.overflow = 'hidden'
    await frames(3)
    for (const selector of FRAME) { box(selector).scrollTop = 300; box(selector).scrollLeft = 300 }
    await frames(3)
    return { shell: offsets() }
  },
  async control() { box('#control-target').scrollIntoView({ block: 'center' }); await frames(3); return control.scrollTop }
} })
