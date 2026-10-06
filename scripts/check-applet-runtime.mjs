import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = await mkdtemp(join(tmpdir(), 'mousse-applet-probe-'))
try {
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import {app,BrowserWindow,webContents,nativeImage} from 'electron'; import {execFileSync} from 'node:child_process';
    import assert from 'node:assert/strict';
    import {AppletRuntimeManager} from './src/main/applets/AppletRuntimeManager';import {exportAppletHtml} from './src/mms/applets/AppletStore';
    const layoutOnly=process.argv.includes('--layout-lifecycle');app.setPath('userData',process.argv[2]);const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
    app.whenReady().then(async()=>{
      const owner=new BrowserWindow({width:800,height:600,frame:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      const events=[];const manager=new AppletRuntimeManager(owner,event=>events.push(event));
      const bounds={x:100,y:100,width:400,height:300},clip={x:0,y:0,width:800,height:450};
      const mount=(id,source)=>manager.mount({runtimeId:id,threadId:'test',revisionId:id,source,bounds,clip});
      try{
        await owner.loadURL('data:text/html,<body style="margin:0;background:rgb(0,255,0)">Owner</body>');owner.webContents.setZoomFactor(1);owner.setPosition(0,0);
        await mount('working',{html:'<main class="red"><button id="button">Add</button><output id="count">0</output></main>',css:'.red{background:rgb(255,0,0);height:100vh}',js:'document.querySelector("button").onclick=()=>{document.querySelector("output").textContent="1";mousseApplet.saveState({count:1})};mousseApplet.saveState({node:typeof require,host:typeof window.mousse,rtc:typeof RTCPeerConnection});fetch("https://example.com").then(()=>mousseApplet.reportError("NETWORK LEAK"),()=>mousseApplet.saveState({network:"blocked"}));'});
        await pause(250);
        const guest=webContents.getAllWebContents().find(w=>w.id!==owner.webContents.id);
        assert(guest);const originalSession=guest.session,originalUrl=guest.getURL();if(!layoutOnly){assert.notEqual(guest.getOSProcessId(),owner.webContents.getOSProcessId(),'Guest needs an independent process');
        assert(events.some(e=>e.type==='state'&&e.payload.node==='undefined'&&e.payload.host==='undefined'&&e.payload.rtc==='undefined'));
        assert(events.some(e=>e.type==='state'&&e.payload.network==='blocked'));assert.equal(await guest.executeJavaScript('fetch("file:///etc/passwd").then(()=>"leaked",()=>"blocked")'),'blocked','Host file reads are blocked');assert.equal(await guest.executeJavaScript('window.open("https://example.com")'),null,'Popups blocked');
        assert.equal(await guest.executeJavaScript('(()=>{const f=document.createElement("iframe");document.body.append(f);let result;try{result=typeof f.contentWindow.RTCPeerConnection}catch(e){result=e.name};f.remove();return result})()'),'SecurityError','Fresh iframe cannot restore forbidden RTC globals');await guest.executeJavaScript('document.querySelector("button").click()');
        assert(events.some(e=>e.type==='state'&&e.payload.count===1));guest.focus();guest.sendInputEvent({type:'keyDown',keyCode:'Escape'});await pause(80);assert(owner.webContents.isFocused(),'Escape returns keyboard focus to thread');}
        // A partially scrolled card must retain its content width and clip at composer.
        manager.layout('working',{...bounds,y:350},clip);await pause(180);
        const screenshot=nativeImage.createFromBuffer(execFileSync('import',['-window',String(owner.getNativeWindowHandle().readUInt32LE()),'png:-']));const bitmap=screenshot.toBitmap();const size=screenshot.getSize();
        const pixel=(x,y)=>{const scale=size.width/owner.getContentSize()[0];const at=(Math.round(y*scale)*size.width+Math.round(x*scale))*4;return Array.from(bitmap.subarray(at,at+3))};
        assert.deepEqual(pixel(150,400),[0,0,255],'Applet paints inside clip');
        assert.deepEqual(pixel(150,470),[0,255,0],'Applet does not cover composer below clip');
        owner.webContents.setZoomFactor(1.25);manager.layout('working',{...bounds,y:350},clip);await pause(180);
        assert.equal(guest.getZoomFactor(),1.25);assert.equal(await guest.executeJavaScript('innerWidth'),400,'Guest viewport remains in CSS pixels at host zoom');
        const zoomImage=nativeImage.createFromBuffer(execFileSync('import',['-window',String(owner.getNativeWindowHandle().readUInt32LE()),'png:-']));const zoomPixels=zoomImage.toBitmap(),zoomSize=zoomImage.getSize();const zoomPixel=(x,y)=>{const scale=zoomSize.width/owner.getContentSize()[0];const at=(Math.round(y*scale)*zoomSize.width+Math.round(x*scale))*4;return Array.from(zoomPixels.subarray(at,at+3))};
        assert.deepEqual(zoomPixel(187,500),[0,0,255],'Zoomed applet paints inside scaled clip');assert.deepEqual(zoomPixel(187,587),[0,255,0],'Zoomed applet does not cover composer');
        await guest.executeJavaScript('document.querySelector("output").textContent="0"');const button=await guest.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:Math.round((r.x+r.width/2)*1.25),y:Math.round((r.y+r.height/2)*1.25)}})()');guest.sendInputEvent({type:'mouseDown',...button,button:'left',clickCount:1});await pause(40);guest.sendInputEvent({type:'mouseUp',...button,button:'left',clickCount:1});await pause(80);assert.equal(await guest.executeJavaScript('document.querySelector("output").textContent'),'1','Zoomed guest remains interactive');
        owner.webContents.setZoomFactor(1);manager.layout('working',bounds,clip);
        const started=Date.now();for(let n=0;n<120;n++)manager.layout('working',{...bounds,y:100+n},clip);assert(Date.now()-started<1000,'Geometry updates should not wait on guest JS');
        await mount('second',{html:'',css:'',js:''});await mount('third',{html:'',css:'',js:''});await assert.rejects(mount('fourth',{html:'',css:'',js:''}),/Only three/);manager.unmount('second');manager.unmount('third');manager.unmount('working');
        if(!layoutOnly){await mount('loop',{html:'',css:'',js:'setTimeout(()=>{while(true){}},50)'});await pause(150);
        assert.equal(await owner.webContents.executeJavaScript('1+1'),2,'Owner survives infinite loop');
        await pause(5600);assert(events.some(e=>e.runtimeId==='loop'&&e.type==='error'&&String(e.payload).includes('stopped responding')),'Independent host watchdog stops infinite loops');manager.unmount('loop');await pause(100);assert.equal(await owner.webContents.executeJavaScript('2+2'),4,'Owner survives guest termination');
        const exported=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        try{await exported.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(exportAppletHtml({schemaVersion:1,stateVersion:1,title:'Export fixture',description:'Security fixture',html:'<button id="export">Test</button>',css:'',js:'document.body.dataset.executed="yes"'})));await pause(150);const child=exported.webContents.mainFrame.frames[0];assert(child,'Export iframe exists');assert.equal(await child.executeJavaScript('document.body.dataset.executed'),'yes','Export JavaScript runs');assert.equal(await child.executeJavaScript('(()=>{const f=document.createElement("iframe");document.body.append(f);try{return typeof f.contentWindow.RTCPeerConnection}catch(e){return e.name}})()'),'SecurityError','Export descendant cannot restore RTC');assert.equal(await child.executeJavaScript('fetch("https://example.com").then(()=>"leaked",()=>"blocked")'),'blocked','Export denies fetch')}finally{exported.destroy()}}

        manager.destroy();const restarted=new AppletRuntimeManager(owner,event=>events.push(event));try{await restarted.mount({runtimeId:'restart',threadId:'test',revisionId:'restart',source:{html:'<output>new</output>',css:'',js:''},bounds,clip});const nextGuest=webContents.getAllWebContents().find(w=>w.id!==owner.webContents.id);assert(nextGuest);assert.equal(nextGuest.session,originalSession,'Manager restart reuses bounded owner partition');assert.notEqual(nextGuest.getURL(),originalUrl,'Manager restart never reuses a source URL');try{const stale=await nextGuest.session.fetch(originalUrl);assert.equal(stale.status,403,'Previous document is unavailable')}catch(error){assert(/ERR_BLOCKED|Failed to fetch|net::ERR/.test(String(error)),'Stale document is denied')};assert.equal(await nextGuest.executeJavaScript('document.querySelector("output").textContent'),'new')}finally{restarted.destroy()};console.log(layoutOnly?'Applet layout/lifecycle passed: native composer clipping, zoom1.25 interaction, bounded geometry, session reuse and stale document rejection.':'Applet runtime passed: separate process, interaction, no host/Node/RTC, networking blocked, native composer clipping, bounded geometry, infinite-loop termination.');owner.destroy();app.quit();
      }catch(error){console.error(error);manager.destroy();owner.destroy();app.exit(1)}
    });
  `
    },
    outfile: join(directory, 'probe.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(
      electron,
      [join(directory, 'probe.cjs'), directory, ...process.argv.slice(2), '--ozone-platform=x11'],
      {
        env,
        stdio: 'inherit'
      }
    )
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Applet probe timed out'))
    }, 25_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error('Applet probe failed: ' + code))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
