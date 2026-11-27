// The production applet card, preload and IPC in a window that routes applet webviews as the app's main process does.
// Checks the whole path a user sees: the page starts, takes real mouse and wheel input, draws under the window's own
// menus and composer, keeps its live state while scrolled away, and follows a theme change.
//   node scripts/check-in-thread-applets.mjs
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = await mkdtemp(join(tmpdir(), 'mousse-in-thread-applets-'))
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
    function Fixture(){const[menu,setMenu]=React.useState(false);return <div className="mousse-chat-shell"><nav style={{height:40}}><button id="menu" onClick={()=>setMenu(!menu)}>Menu</button></nav>{menu&&<div role="menu" style={{position:'absolute',top:120,left:100,width:200,height:80,zIndex:99,background:'rgb(51,51,51)'}}>Host menu</div>}<div className="an-message-list" style={{position:'absolute',top:40,left:0,right:0,height:400,overflowY:'auto'}}><AppletCard reference={ref}/><div style={{height:1600}}>Transcript after applet</div></div><div className="chat-composer-stack" style={{position:'absolute',top:300,left:0,right:0,bottom:0,background:'rgb(0,255,0)'}}>Composer</div></div>}
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
    import {app,BrowserWindow,ipcMain,webContents} from 'electron';
    import assert from 'node:assert/strict';
    import {isAppletWebviewSource} from './src/main/applets/AppletRuntimeManager';
    import {registerAppletIpc,attachAppletWebview,adoptAppletWebview} from './src/main/applets/registerAppletIpc';
    app.setPath('userData',${JSON.stringify(join(directory, 'user-data'))});
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    app.whenReady().then(async()=>{
      const owner=new BrowserWindow({width:800,height:600,frame:false,webPreferences:{preload:${JSON.stringify(join(directory, 'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:true}});
      // As src/main/index.ts routes them: only a minted applet address attaches, into its applet's own session.
      owner.webContents.on('will-attach-webview',(event,webPreferences,params)=>{if(!isAppletWebviewSource(params.src)||!attachAppletWebview(owner.webContents,webPreferences,params))event.preventDefault()});
      owner.webContents.on('did-attach-webview',(_event,guest)=>{adoptAppletWebview(owner.webContents,guest)});
      let saved={count:0};
      const bundle={schemaVersion:1,appletId:'applet',revisionId:'revision',sourceHash:'hash',title:'Interactive costs',description:'Saved counter illustration',threadId:'thread',messageId:'message',turnId:'turn',createdAt:new Date().toISOString(),runtimePolicyVersion:1,source:{schemaVersion:1,title:'Interactive costs',description:'Saved counter illustration',stateVersion:1,html:'<main class="applet-canvas"><button id="increment">Add one</button><output id="count"></output><div id="nested" style="height:80px;overflow:auto"><div style="height:200px;background:rgb(255,255,0)">Top</div><div style="height:400px;background:rgb(0,255,255)">Scrolled content</div></div><div style="height:120px"></div></main>',css:'.applet-canvas{background:rgb(255,0,0)}button{margin:20px;padding:15px}',js:'let count=mousseApplet.state?.count??0;document.querySelector("output").textContent=count;document.querySelector("button").onclick=()=>{count++;document.querySelector("output").textContent=count;mousseApplet.saveState({count})}'} };
      const gui={on:()=>{},getWindowBindingForSender:()=>({profileId:'profile',epoch:1}),runWithSender:(_sender,callback)=>callback(),request:async(method,input)=>{assert.equal(input.threadId,'thread');if(method==='applets.get')return bundle;if(method==='applets.state.get')return{state:saved};if(method==='applets.state.save'){saved=input.state;return{ok:true}}throw new Error('Unexpected request '+method)}};
      registerAppletIpc((channel,handler)=>ipcMain.handle(channel,handler),gui,()=>[owner]);
      const guests=()=>webContents.getAllWebContents().filter(value=>value.getType()==='webview'&&!value.isDestroyed()&&value.getURL().startsWith('mousse-applet:'));
      const host=code=>owner.webContents.executeJavaScript(code).catch(error=>{throw new Error('In the window: '+code.slice(0,120)+': '+error.message)});
      const wait=async(predicate,label)=>{for(let n=0;n<100;n++){if(await predicate())return;await pause(50)}throw new Error('Timed out: '+label)};
      const press=async(point,target=owner.webContents)=>{const x=Math.round(point.x),y=Math.round(point.y);target.sendInputEvent({type:'mouseMove',x,y});await pause(50);target.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});await pause(50);target.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await pause(160)};
      const click=async(text)=>press(await host('(()=>{const button=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+');const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'));
      const pixels=async()=>{const image=await owner.webContents.capturePage(),size=image.getSize(),bitmap=image.toBitmap(),scale=size.width/owner.getContentSize()[0];return(x,y)=>{const offset=(Math.round(y*scale)*size.width+Math.round(x*scale))*4;const [b,g,r]=bitmap.subarray(offset,offset+3);return[r,g,b]}};
      const near=(actual,expected,label)=>assert(actual.every((value,index)=>Math.abs(value-expected[index])<=8),label+': '+JSON.stringify(actual));
      const scrollTop=()=>host('document.querySelector(".an-message-list").scrollTop');
      const preview=()=>host('(()=>{const r=document.querySelector(".mousse-applet-preview").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');
      try{
        await owner.loadFile(${JSON.stringify(join(directory, 'index.html'))});owner.show();
        await wait(()=>guests().length===1,'the card starts its page');
        assert(isAppletWebviewSource(await host('document.querySelector("webview").getAttribute("src")')),'The webview draws the minted address');
        assert.equal(await host('document.querySelector("webview").hasAttribute("partition")'),false,'The card asks for no session');
        const first=guests()[0];
        await wait(()=>first.executeJavaScript('document.querySelector("output").textContent==="0"'),'initial applet counter');
        await wait(async()=>(await preview()).height>200,'the card takes the height its page reports');

        // A click in the page is saved through IPC. (Input sent to the window does not reach a webview's page; real
        // pointer input does, which scripts/check-applet-runtime.mjs and a hands-on pass cover. Here it goes to the page.)
        const box=await preview();
        const button=await first.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
        await press(button,first);
        await wait(()=>saved.count===1,'a click in the page saves its state');

        // The page paints in the card, under the composer and under a menu the window opens over it.
        await pause(200);
        let pixel=await pixels();
        near(pixel(700,box.y+30),[255,0,0],'The page paints inside its card');
        near(pixel(700,340),[0,255,0],'The composer draws over the page');
        await click('Menu');await pause(200);
        pixel=await pixels();
        near(pixel(200,160),[51,51,51],'A window menu draws over the page');
        near(pixel(700,box.y+30),[255,0,0],'The page stays drawn while the menu is open');
        assert.equal(guests()[0].id,first.id,'Opening a menu leaves the page running');
        await click('Menu');

        // Wheel over the page: an inner scroller takes it, a page with nothing left to scroll passes it to the thread.
        const nested=await first.executeJavaScript('(()=>{const r=document.querySelector("#nested").getBoundingClientRect();return{x:r.x+60,y:r.y+40}})()');
        const nestedPoint={x:Math.round(nested.x),y:Math.round(nested.y)};
        first.sendInputEvent({type:'mouseMove',...nestedPoint});
        first.sendInputEvent({type:'mouseWheel',...nestedPoint,deltaX:0,deltaY:-200,canScroll:true});
        await wait(async()=>(await first.executeJavaScript('document.querySelector("#nested").scrollTop'))>0,'an inner scroller takes the wheel');
        assert.equal(await scrollTop(),0,'The thread stays put while the inner scroller has room');
        await pause(400);
        const body={x:Math.round(box.width-40),y:30};
        first.sendInputEvent({type:'mouseMove',...body});
        first.sendInputEvent({type:'mouseWheel',...body,deltaX:0,deltaY:-120,canScroll:true});
        await wait(async()=>(await scrollTop())>0,'a wheel the page cannot use scrolls the thread');

        // Scrolled far away and back: the same page, with its unsaved state and its inner scroll.
        await first.executeJavaScript('window.unsavedMarker="kept";document.querySelector("#nested").scrollTop=200');
        await host('document.querySelector(".an-message-list").scrollTop=1500');await pause(600);
        assert.equal(guests().length,1,'A page out of sight keeps running');
        await host('document.querySelector(".an-message-list").scrollTop=0');await pause(400);
        assert.equal(guests()[0].id,first.id,'Scrolling back finds the same page');
        assert.equal(await first.executeJavaScript('window.unsavedMarker'),'kept','Unsaved page state survives scrolling away');
        assert.equal(await first.executeJavaScript('document.querySelector("#nested").scrollTop'),200,'Inner scroll survives scrolling away');

        // A theme change reaches the running page.
        await host('(()=>{const r=document.documentElement;r.dataset.theme="light";r.setAttribute("data-acrylic","true");for(const[k,v]of Object.entries({"--surface-base":"#fafafa","--surface-strong":"#eeeeee","--surface-soft":"#dddddd","--accent":"#6251aa","--accent-rgb":"98,81,170","--text-primary":"#222222","--text-secondary":"#555555","--theme-btn-radius":"11px"}))r.style.setProperty(k,v);r.style.setProperty("--bg-primary","rgba(255,255,255,.4)");r.style.setProperty("--glass-blur","blur(20px)");document.body.style.fontFamily="Arial, sans-serif";document.body.style.fontSize="18px"})()');
        await wait(()=>first.executeJavaScript('mousseApplet.appearance.theme==="light" && getComputedStyle(document.documentElement).getPropertyValue("--surface-base").trim()==="#fafafa" && getComputedStyle(document.body).backgroundColor==="rgba(0, 0, 0, 0)"'),'theme change updates the running page');
        const values=await first.executeJavaScript('(()=>{const s=getComputedStyle(document.body),b=getComputedStyle(document.querySelector("button"));return {font:s.fontFamily,size:s.fontSize,color:s.color,blur:s.backdropFilter,radius:b.borderRadius,acrylicToken:document.documentElement.style.getPropertyValue("--glass-blur"),opaque:mousseApplet.appearance.tokens["--bg-primary"],count:document.querySelector("output").textContent}})()');
        assert(values.font.includes('Arial'));assert.equal(values.size,'18px');assert.equal(values.color,'rgb(34, 34, 34)');assert.equal(values.blur,'none');assert.equal(values.acrylicToken,'');assert.equal(values.radius,'11px');assert.equal(values.opaque,'#fafafa');assert.equal(values.count,'1');
        assert.equal(guests()[0].id,first.id,'A theme change keeps the same page');

        console.log('In-thread applet check passed: minted webview address with no renderer session, click and saved state, page under composer and menu, inner-scroll then chained wheel, same page and unsaved state after scrolling away, live theme.');
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
    const child = spawn(electron, [join(directory, 'main.cjs'), ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])], {
      env,
      stdio: 'inherit'
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('In-thread applet check timed out'))
    }, 45_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error('In-thread applet check failed: ' + code))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
