import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = await mkdtemp(join(tmpdir(), 'mousse-in-thread-applets-'))
const screenshot = '/tmp/mousse-in-thread-applets-native.png'
const scrollOnly = process.argv.includes('--scroll-only')
const appearanceOnly = process.argv.includes('--appearance-only')
try {
  await build({
    stdin: {
      loader: 'tsx',
      resolveDir: process.cwd(),
      contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {AppletCard} from './src/renderer/components/applets/AppletCard';
    import {useAppStore} from './src/renderer/stores/appStore';
    useAppStore.setState({activeThreadId:'thread',profileId:'profile'});
    const ref={appletId:'applet',revisionId:'revision',sourceHash:'hash',title:'Interactive costs',description:'Saved counter illustration'};
    function Fixture(){const[menu,setMenu]=React.useState(false);return <div className="mousse-chat-shell"><nav style={{height:40}}><button id="menu" onClick={()=>setMenu(!menu)}>Menu</button></nav>{menu&&<div role="menu" style={{position:'absolute',top:60,left:100,zIndex:99,background:'#333',padding:30}}>Host menu</div>}<div className="an-message-list" style={{position:'absolute',top:40,left:0,right:0,height:390,overflowY:'auto'}}><AppletCard reference={ref}/><div style={{height:400}}>Transcript after applet</div></div><div className="chat-composer-stack" style={{position:'absolute',top:430,left:0,right:0,bottom:0,background:'rgb(0,255,0)'}}>Composer remains accessible</div></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `
    },
    outfile: join(directory, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic'
  })
  await writeFile(
    join(directory, 'index.html'),
    '<html data-theme="dark"><head><link rel="stylesheet" href="renderer.css"></head><body style="margin:0;background:rgb(0,0,255)"><div id="root"></div><script src="renderer.js"></script></body></html>'
  )
  await build({
    entryPoints: ['src/preload/index.ts'],
    outfile: join(directory, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import {app,BrowserWindow,ipcMain,webContents,nativeImage} from 'electron';
    import {execFileSync} from 'node:child_process';import {writeFileSync} from 'node:fs';import assert from 'node:assert/strict';
    import {AppletRuntimeManager} from './src/main/applets/AppletRuntimeManager';
    import {registerAppletIpc} from './src/main/applets/registerAppletIpc';
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    let snapshotCalls=0;
    if (${scrollOnly}) {
      const snapshot=AppletRuntimeManager.prototype.snapshot;
      AppletRuntimeManager.prototype.snapshot=async function(id){snapshotCalls++;await pause(600);return snapshot.call(this,id)};
    }
    app.whenReady().then(async()=>{
      const owner=new BrowserWindow({width:800,height:600,frame:false,webPreferences:{preload:${JSON.stringify(join(directory, 'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false}});
      let saved={count:0};
      const bundle={schemaVersion:1,appletId:'applet',revisionId:'revision',sourceHash:'hash',title:'Interactive costs',description:'Saved counter illustration',threadId:'thread',messageId:'message',turnId:'turn',createdAt:new Date().toISOString(),runtimePolicyVersion:1,source:{schemaVersion:1,title:'Interactive costs',description:'Saved counter illustration',stateVersion:1,html:'<main class="applet-canvas"><button id="increment">Add one</button><output id="count"></output></main>',css:'.applet-canvas{background:rgb(255,0,0);min-height:100vh}button{margin:20px;padding:15px}',js:'let count=mousseApplet.state?.count??0;document.querySelector("output").textContent=count;document.querySelector("button").onclick=()=>{count++;document.querySelector("output").textContent=count;mousseApplet.saveState({count})}'} };
      const gui={on:()=>{},getWindowBindingForSender:()=>({profileId:'profile',epoch:1}),runWithSender:(_sender,callback)=>callback(),request:async(method,input)=>{assert.equal(input.threadId,'thread');if(method==='applets.get')return bundle;if(method==='applets.state.get')return{state:saved};if(method==='applets.state.save'){saved=input.state;return{ok:true}}throw new Error('Unexpected request '+method)}};
      registerAppletIpc((channel,handler)=>ipcMain.handle(channel,handler),gui,()=>[owner]);
      const guests=()=>webContents.getAllWebContents().filter(value=>value.id!==owner.webContents.id&&value.getURL().startsWith('mousse-applet:'));
      const wait=async(predicate,label)=>{for(let n=0;n<60;n++){if(await predicate())return;await pause(50)}throw new Error('Timed out: '+label)};
      const click=async(text)=>{const point=await owner.webContents.executeJavaScript('(()=>{const button=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+');if(!button)throw new Error("Missing button");const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');owner.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y)});await pause(50);owner.webContents.sendInputEvent({type:'mouseDown',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});await pause(50);owner.webContents.sendInputEvent({type:'mouseUp',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});await pause(160)};
      try{
        await owner.loadFile(${JSON.stringify(join(directory, 'index.html'))});owner.show();
        await wait(()=>guests().length===1,'initial production card mount');
        assert.equal(await owner.webContents.executeJavaScript('getComputedStyle(document.querySelector(".mousse-applet-actions button")).color'),'rgb(232, 232, 236)','Dark toolbar inherits readable foreground');
        const first=guests()[0];await wait(()=>first.executeJavaScript('document.querySelector("output").textContent==="0"'),'initial applet counter');
        await pause(350);
        execFileSync('import',['-window',String(owner.getNativeWindowHandle().readUInt32LE()),'/tmp/mousse-in-thread-applets-initial.png']);
        const point=await first.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
        first.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y)});await pause(50);first.sendInputEvent({type:'mouseDown',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});await pause(50);first.sendInputEvent({type:'mouseUp',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
        await wait(()=>saved.count===1,'real pointer interaction persisted through production IPC');
        if (${appearanceOnly}) {
          const id=first.id;
          await owner.webContents.executeJavaScript('(()=>{const r=document.documentElement;r.dataset.theme="light";r.setAttribute("data-acrylic","true");for(const[k,v]of Object.entries({"--surface-base":"#fafafa","--surface-strong":"#eeeeee","--surface-soft":"#dddddd","--accent":"#6251aa","--accent-rgb":"98,81,170","--text-primary":"#222222","--text-secondary":"#555555","--theme-btn-radius":"11px"}))r.style.setProperty(k,v);r.style.setProperty("--bg-primary","rgba(255,255,255,.4)");r.style.setProperty("--glass-blur","blur(20px)");document.body.style.fontFamily="Arial, sans-serif";document.body.style.fontSize="18px"})()');
          await wait(()=>first.executeJavaScript('mousseApplet.appearance.theme==="light" && getComputedStyle(document.body).backgroundColor==="rgb(250, 250, 250)"'),'theme change updates mounted guest');
          const values=await first.executeJavaScript('(()=>{const s=getComputedStyle(document.body),b=getComputedStyle(document.querySelector("button"));return {font:s.fontFamily,size:s.fontSize,color:s.color,blur:s.backdropFilter,radius:b.borderRadius,acrylicToken:document.documentElement.style.getPropertyValue("--glass-blur"),opaque:mousseApplet.appearance.tokens["--bg-primary"],count:document.querySelector("output").textContent}})()');
          assert(values.font.includes('Arial'));assert.equal(values.size,'18px');assert.equal(values.color,'rgb(34, 34, 34)');assert.equal(values.blur,'none');assert.equal(values.acrylicToken,'');assert.equal(values.radius,'11px');assert.equal(values.opaque,'#fafafa');assert.equal(values.count,'1');assert.equal(guests()[0].id,id);
          assert(await first.executeJavaScript('(()=>{const icon=mousseApplet.icon("plus",{label:"Add"});document.querySelector("button").prepend(icon);return icon.tagName==="svg"&&icon.getAttribute("data-icon-library")==="hugeicons"&&icon.querySelector("path")!==null})()'));
          await pause(150);execFileSync('import',['-window',String(owner.getNativeWindowHandle().readUInt32LE()),'/tmp/mousse-applet-appearance-card.png']);
          console.log('Production card appearance passed: live light-theme/accent/font/radius update, same guest/state, opaque surfaces without acrylic, real Mousse icon geometry.');
          owner.destroy();app.quit();return;
        }
        if (${scrollOnly}) {
          await wait(()=>owner.webContents.executeJavaScript('!!document.querySelector(".mousse-applet-scroll-frame")'),'cached frame prepared before scrolling');
          await pause(800);
          const capturesBefore=snapshotCalls;
          const firstId = first.id;
          const before = await owner.webContents.executeJavaScript('document.querySelector(".an-message-list").scrollTop');
          const header = await owner.webContents.executeJavaScript('(()=>{const r=document.querySelector(".mousse-applet-header").getBoundingClientRect();return{x:Math.round(r.x+100),y:Math.round(r.y+r.height/2)}})()');
          owner.webContents.sendInputEvent({type:'mouseMove',...header});
          const wheelAt=Date.now();
          owner.webContents.sendInputEvent({type:'mouseWheel',...header,deltaX:0,deltaY:-24,canScroll:true});
          await wait(()=>owner.webContents.executeJavaScript('document.querySelector(".an-message-list").scrollTop>'+before),'header wheel scrolls transcript');
          assert(Date.now()-wheelAt<400,'Header scroll responds without waiting for the 600ms snapshot');
          await wait(()=>owner.webContents.executeJavaScript('!!document.querySelector(".mousse-applet-scroll-frame")'),'host DOM snapshot replaces native guest during scroll');
          assert.equal(guests()[0].id,firstId,'Scrolling preserves the guest renderer');
          assert.equal(owner.contentView.children[0].getVisible(),false,'Native surface is hidden while host scrolls');
          for(let n=0;n<12;n++){
            owner.webContents.sendInputEvent({type:'mouseWheel',...header,deltaX:0,deltaY:n<6?-3:3,canScroll:true});
            await pause(16);
            assert.equal(owner.contentView.children[0].getVisible(),false,'Native guest cannot overlap scrolling header');
          }
          assert.equal(snapshotCalls,capturesBefore,'Scrolling never starts an expensive snapshot capture');
          await wait(()=>owner.contentView.children[0].getVisible(),'live guest resumes after gesture');
          assert.equal(guests()[0].id,firstId,'Resume does not reload guest');
          assert.equal(await first.executeJavaScript('document.querySelector("output").textContent'),'1','Interaction survives header scrolling');
          const rect=await owner.webContents.executeJavaScript('(()=>{const r=document.querySelector(".mousse-applet-preview").getBoundingClientRect();return{top:r.top,bottom:r.bottom}})()');
          const image=nativeImage.createFromBuffer(execFileSync('import',['-window',String(owner.getNativeWindowHandle().readUInt32LE()),'png:-']));
          const size=image.getSize(),bitmap=image.toBitmap(),scale=size.width/owner.getContentSize()[0];
          const pixel=(x,y)=>{const offset=(Math.round(y*scale)*size.width+Math.round(x*scale))*4;return Array.from(bitmap.subarray(offset,offset+3))};
          assert.notDeepEqual(pixel(600,Math.round(rect.top)-5),[0,0,255],'Native preview does not cover toolbar');
          assert.deepEqual(pixel(600,Math.round(rect.top)+25),[0,0,255],'Live preview returns at current DOM position');
          assert.deepEqual(pixel(600,500),[0,255,0],'Composer stays clear after gesture');
          await owner.webContents.executeJavaScript('document.querySelector(".an-message-list").scrollTop=700');
          await wait(()=>guests().length===0,'offscreen guest tears down during gesture');
          await owner.webContents.executeJavaScript('document.querySelector(".an-message-list").scrollTop=0');
          await pause(50);
          assert.equal(guests().length,0,'Newly visible preview waits for scroll to settle');
          await wait(()=>guests().length===1,'newly visible preview mounts after gesture');
          await wait(()=>guests()[0].executeJavaScript('document.querySelector("output").textContent==="1"'),'offscreen return restores saved state');
          console.log('Header wheel regression passed: passive scrolling with 600ms snapshot latency, no captures during gesture, cached DOM frame, no native header overlap, same guest/state after resume, composer clipping.');
          owner.destroy();app.quit();return;
        }
        await pause(100);const image=nativeImage.createFromBuffer(execFileSync('import',['-window',String(owner.getNativeWindowHandle().readUInt32LE()),'png:-']));writeFileSync(${JSON.stringify(screenshot)},image.toPNG());
        const bitmap=image.toBitmap(),size=image.getSize();const pixel=(x,y)=>{const scale=size.width/owner.getContentSize()[0];const offset=(Math.round(y*scale)*size.width+Math.round(x*scale))*4;return Array.from(bitmap.subarray(offset,offset+3))};
        assert.deepEqual(pixel(600,400),[0,0,255],'Native guest paints inside preview');assert.deepEqual(pixel(600,500),[0,255,0],'Native guest is clipped above composer');
        await click('Menu');await wait(()=>guests().length===0,'host menu hides guest');await click('Menu');await wait(()=>guests().length===1,'closing menu restores guest');
        await wait(()=>guests()[0].executeJavaScript('document.querySelector("output").textContent==="1"'),'menu remount restores saved state');
        await click('Source');await wait(()=>guests().length===0,'source button remains reachable and hides guest');
        assert(await owner.webContents.executeJavaScript('document.querySelector(".mousse-applet-source pre").textContent.includes("increment")'));
        await click('Preview');await wait(()=>guests().length===1,'source returns to preview');await click('Restart');await wait(()=>guests().length===1,'restart remounts guest');
        await wait(()=>guests()[0].executeJavaScript('document.querySelector("output").textContent==="1"'),'restart restores persisted state');
        await owner.webContents.executeJavaScript('document.querySelector(".an-message-list").scrollTop=700');await wait(()=>guests().length===0,'offscreen guest unmount');
        console.log('Production applet card passed: Electron mouse input controls, source/restart, menu suspension, saved state, composer clipping, offscreen teardown. Screenshot: '+${JSON.stringify(screenshot)});
        owner.destroy();app.quit();
      }catch(error){console.error(error);owner.destroy();app.exit(1)}
    });
  `
    },
    outfile: join(directory, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(directory, 'main.cjs'), '--ozone-platform=x11'], {
      env,
      stdio: 'inherit'
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Production applet UI probe timed out'))
    }, 25_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error('Production applet UI probe failed: ' + code))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
