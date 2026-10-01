import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

if (process.platform !== 'linux' || !process.env.DISPLAY) throw new Error('Run this native resize check on Linux with an X11/Xwayland display')
const directory = await mkdtemp(join(tmpdir(), 'mousse-linux-window-resize-'))
const repo = new URL('..', import.meta.url).pathname
try {
  await build({ entryPoints: [join(repo, 'src/preload/index.ts')], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'
    import { LinuxWindowResizeHandles } from './src/renderer/components/LinuxWindowResizeHandles'
    createRoot(document.getElementById('root')).render(<><main><div className="titlebar">Native titlebar drag region</div><button id="content-button">Content remains clickable</button><div className="modal">Portaled overlay</div></main><LinuxWindowResizeHandles /></>)
    window.errors=[];window.addEventListener('error',event=>window.errors.push(event.message));window.addEventListener('unhandledrejection',event=>window.errors.push(String(event.reason)))
  ` }, outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  await writeFile(join(directory, 'fixture.html'), `<html class="platform-linux"><head><link rel="stylesheet" href="renderer.css"><style>html,body,#root,main{margin:0;width:100%;height:100%;box-sizing:border-box}main{background:rgba(30,24,36,.7);color:white;font:14px sans-serif}.titlebar{height:48px;-webkit-app-region:drag}#content-button{position:absolute;top:180px;left:260px}.modal{position:fixed;inset:0;z-index:10000;pointer-events:none}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  await build({ stdin: { resolveDir: repo, loader: 'ts', contents: `
    import assert from 'node:assert/strict'
    import { join } from 'node:path'
    import { app, BrowserWindow, screen } from 'electron'
    import { registerLinuxWindowResizeIpc } from './src/main/linuxWindowResizeIpc'
    import { configureLinuxWindowing, linuxTransparencyOptions } from './src/main/linuxRendering'
    import { BrowserViewManager } from './src/main/browser/BrowserViewManager'
    assert.equal(configureLinuxWindowing(app, process.platform, process.env),false)
    const pause = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms))
    // Electron delivers actual PointerEvents/capture. Only the physical cursor
    // position is deterministic, so this test never moves the user's mouse.
    let cursor={x:100,y:100}
    assert.equal(app.commandLine.getSwitchValue('ozone-platform'),'x11')
    const fixture=process.argv[2]
    app.whenReady().then(async()=>{
      screen.getCursorScreenPoint=()=>cursor
      let main:BrowserWindow|null=null, auxiliary:BrowserWindow|null=null
      const browser=new BrowserViewManager()
      const create=(width:number,height:number,preload=join(fixture,'preload.cjs'))=>new BrowserWindow({width,height,x:80,y:60,show:true,frame:false,minWidth:480,minHeight:360,
        ...linuxTransparencyOptions(process.platform),backgroundColor:'#00000000',webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}})
      try {
        main=create(800,600);auxiliary=create(560,420)
        registerLinuxWindowResizeIpc(()=>main,()=>auxiliary)
        for(const win of [main,auxiliary])await win.loadFile(join(fixture,'fixture.html'))
        await pause(150)
        const runGesture=async(win:BrowserWindow,edge:string,dx:number,dy:number)=>{
          win.show();win.focus();await pause(80)
          const original=win.getBounds(),size=win.getContentBounds()
          const point={x:edge.includes('w')?12:edge.includes('e')?size.width-12:size.width/2,
            y:edge.includes('n')?12:edge.includes('s')?size.height-12:size.height/2}
          if(edge==='n')point.y=2;if(edge==='s')point.y=size.height-2;if(edge==='e')point.x=size.width-2;if(edge==='w')point.x=2
          const hit=await win.webContents.executeJavaScript('document.elementFromPoint('+point.x+','+point.y+').dataset.resizeEdge')
          assert.equal(hit,edge,'Native edge target must be reachable above titlebar and overlays')
          cursor={x:original.x+point.x,y:original.y+point.y}
          win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y})
          win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:point.x,y:point.y})
          await pause(40)
          assert(await win.webContents.executeJavaScript('document.querySelector("[data-resize-edge='+edge+']").hasPointerCapture(1)'),edge+' captures the pointer')
          cursor={x:cursor.x+dx,y:cursor.y+dy}
          win.webContents.sendInputEvent({type:'mouseMove',modifiers:['leftButtonDown'],x:point.x+dx,y:point.y+dy})
          await pause(90)
          const changed=win.getBounds()
          const width=original.width+(edge.includes('e')?dx:edge.includes('w')?-dx:0),height=original.height+(edge.includes('s')?dy:edge.includes('n')?-dy:0)
          assert.equal(changed.width,width,edge+' width');assert.equal(changed.height,height,edge+' height')
          assert.equal(changed.x,edge.includes('w')?original.x+dx:original.x,edge+' anchored x')
          assert.equal(changed.y,edge.includes('n')?original.y+dy:original.y,edge+' anchored y')
          win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:cursor.x-changed.x,y:cursor.y-changed.y})
          await pause(30)
          win.setBounds(original);await pause(40)
        }
        for(const edge of ['n','ne','e','se','s','sw','w','nw'])await runGesture(main,edge,40,30)
        await runGesture(auxiliary,'se',30,20)
        assert.equal(await main.webContents.executeJavaScript('document.elementFromPoint(270,190).id'),'content-button','Resize overlay must not swallow interior input')
        browser.init(()=>main,()=>{});browser.setVisible(true);browser.setBounds({x:0,y:48,width:800,height:552})
        const child=main.contentView.children.find(view=>view!==main!.webContentsView)!
        const browserBounds=child.getBounds()
        assert.equal(browserBounds.x,6);assert.equal(browserBounds.width,788);assert.equal(browserBounds.height,546,'Native guest preserves the bottom resize border')
        await runGesture(main,'e',40,0)
        browser.destroy()
        const unrelated=create(520,400);await unrelated.loadFile(join(fixture,'fixture.html'))
        assert.equal(await unrelated.webContents.executeJavaScript('window.mousse.window.resizeStart("e",1)'),false,'Unrelated popup cannot control app windows')
        unrelated.destroy()
        await main.webContents.executeJavaScript('document.documentElement.dataset.windowMaximized="true"')
        assert.equal(await main.webContents.executeJavaScript('getComputedStyle(document.querySelector(".linux-window-resize-handles")).display'),'none')
        await main.webContents.executeJavaScript('document.documentElement.dataset.windowMaximized="false"')
        assert.equal(await main.webContents.executeJavaScript('document.querySelectorAll(".linux-window-resize-handle").length'),8)
        const image=await main.webContents.capturePage(),bitmap=image.toBitmap(),size=image.getSize()
        assert.equal(bitmap[3],0,'Rounded corner stays transparent')
        const center=((Math.floor(size.height/2)*size.width)+Math.floor(size.width/2))*4+3
        assert(bitmap[center]>0 && bitmap[center]<255,'Acrylic alpha survives resizing')
        for(const win of [main,auxiliary])assert.deepEqual(await win.webContents.executeJavaScript('window.errors'),[])
        console.log('Linux resize passed: all eight native pointer gestures, opposite-edge anchors, auxiliary ownership, renderer hit areas, native browser border, popup denial, maximize visibility, rounded alpha corners and acrylic transparency.')
        main.destroy();auxiliary.destroy();app.quit()
      }catch(error){console.error(error);browser.destroy();main?.destroy();auxiliary?.destroy();app.exit(1)}
    })
  ` }, outfile: join(directory, 'check.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(electron,[join(directory,'check.cjs'),directory,'--ozone-platform=x11'],{env,stdio:'inherit'})
    const timer=setTimeout(()=>{child.kill();reject(new Error('Native Linux window resize check timed out'))},30_000)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',code=>{clearTimeout(timer);resolve(code)})
  })
  if(result!==0)throw new Error('Native Linux window resize check failed: '+result)
}finally{await rm(directory,{recursive:true,force:true})}
