import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

if (process.platform !== 'linux' || !process.env.DISPLAY) throw new Error('An X11/Xwayland Linux desktop is required')
const directory = await mkdtemp(join(tmpdir(), 'mousse-caption-close-'))
const repo = new URL('..', import.meta.url).pathname
try {
  await build({ entryPoints: [join(repo, 'src/preload/index.ts')], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'
    import { WindowCloseButton } from './src/renderer/components/WindowCloseButton'
    import { LinuxWindowResizeHandles } from './src/renderer/components/LinuxWindowResizeHandles'
    createRoot(document.getElementById('root')).render(<><WindowCloseButton onClose={()=>window.mousse.window.close()}>Close</WindowCloseButton><LinuxWindowResizeHandles /></>)
  ` }, outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  await writeFile(join(directory, 'fixture.html'), '<html class="platform-linux"><head><link rel="stylesheet" href="renderer.css"><style>body{margin:0;background:#222}.titlebar-close{position:absolute;right:8px;top:8px;width:34px;height:34px;-webkit-app-region:no-drag}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
  await build({ stdin: { resolveDir: repo, loader: 'ts', contents: `
    import assert from 'node:assert/strict'
    import {join} from 'node:path'
    import {app,BrowserWindow,ipcMain,screen} from 'electron'
    import {registerLinuxWindowResizeIpc} from './src/main/linuxWindowResizeIpc'
    const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
    const fixture=process.argv[2]
    app.whenReady().then(async()=>{
      let closes=0,cursor={x:100,y:100}
      screen.getCursorScreenPoint=()=>cursor
      const win=new BrowserWindow({width:800,height:600,show:true,frame:false,webPreferences:{preload:join(fixture,'preload.cjs'),contextIsolation:true,sandbox:false}})
      registerLinuxWindowResizeIpc(()=>win,()=>null)
      ipcMain.handle('window:close',()=>{closes++})
      try{
        await win.loadFile(join(fixture,'fixture.html'));await pause(150)
        const js=(code:string)=>win.webContents.executeJavaScript(code)
        const point=()=>js('(()=>{const r=document.querySelector(".titlebar-close").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
        // An unarmed mouse click represents a click retargeted after resizing.
        await js('document.querySelector(".titlebar-close").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1}))');await pause(40);assert.equal(closes,0)
        const p=await point()
        win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});await pause(40)
        win.webContents.sendInputEvent({type:'mouseMove',x:p.x-80,y:p.y+80});await pause(40)
        win.webContents.sendInputEvent({type:'mouseMove',...p});await pause(40)
        win.webContents.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount:1})
        await pause(60);assert.equal(closes,0,'Dragging from the caption must not close the window')
        const corner=await js('(()=>{const r=document.querySelector(".resize-ne").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
        win.webContents.sendInputEvent({type:'mouseDown',...corner,button:'left',clickCount:1});await pause(30)
        cursor={x:125,y:115};win.webContents.sendInputEvent({type:'mouseMove',x:corner.x+25,y:corner.y+15});await pause(80)
        win.webContents.sendInputEvent({type:'mouseUp',...(await point()),button:'left',clickCount:1});await pause(50)
        await js('document.querySelector(".titlebar-close").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1}))');await pause(40)
        assert.equal(closes,0,'Resize release over Close must not request shutdown');assert(!win.isDestroyed())
        const close=await point();win.webContents.sendInputEvent({type:'mouseDown',...close,button:'left',clickCount:1});await pause(40);win.webContents.sendInputEvent({type:'mouseUp',...close,button:'left',clickCount:1});await pause(60);assert.equal(closes,1,'Intentional mouse click still closes')
        await js('document.querySelector(".titlebar-close").focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});await pause(60);assert.equal(closes,2,'Keyboard activation remains accessible')
        console.log('Linux caption regression passed: drag/resize clicks ignored; deliberate mouse and keyboard Close retained.')
        win.destroy();app.quit()
      }catch(error){console.error(error);win.destroy();app.exit(1)}
    })
  ` }, outfile: join(directory, 'check.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(directory, 'check.cjs'), directory, '--ozone-platform=x11'], { env, stdio: 'inherit' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Caption check timed out')) }, 20_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Caption check failed: ' + code)) })
  })
} finally { await rm(directory, { recursive: true, force: true }) }
