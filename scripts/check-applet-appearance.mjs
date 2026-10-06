import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'
const directory = await mkdtemp(join(tmpdir(), 'mousse-applet-appearance-'))
try {
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
 import {app,BrowserWindow} from 'electron';import assert from 'node:assert/strict';
 import {appletDocument,APPLET_APPLY_APPEARANCE} from './src/shared/appletDocument';
 import {DEFAULT_APPLET_APPEARANCE} from './src/shared/appletAppearanceStyles';
 import {exportAppletHtml} from './src/mms/applets/AppletStore';import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
 app.setPath('userData',process.argv[2]);const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 app.whenReady().then(async()=>{
 const guest=new BrowserWindow({width:680,height:500,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});guest.setMenu(null);
 const source={html:'<main><button id="plain">Plain</button><button id="primary" class="btn btn-primary"><span data-mousse-icon="plus"></span>Add</button><button class="btn btn-ghost">Ghost</button><button class="btn btn-danger">Delete</button><button class="btn btn-success">Done</button><button class="btn btn-sm">Small</button><button class="icon-btn icon-btn-ghost" aria-label="Settings"><span data-mousse-icon="Settings"></span></button><input placeholder="Name"><a href="#">Link</a><div id="scroll" tabindex="0"><div id="nested"><p style="height:200px">Nested</p></div><p style="height:700px">Long</p></div></main>',css:'#scroll{height:80px;overflow:auto;width:250px}#nested{height:30px;overflow:auto;backdrop-filter:blur(10px)!important}#scroll,#nested{scrollbar-width:auto!important;scrollbar-color:red blue!important}#scroll::-webkit-scrollbar,#nested::-webkit-scrollbar{width:30px!important}#scroll::-webkit-scrollbar-thumb{background:red!important}',js:'window.userExecutions=(window.userExecutions||0)+1;document.querySelector("main").appendChild(mousseApplet.icon("gauge",{label:"Gauge"}));'};
 try{
 await guest.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(appletDocument(source,null,DEFAULT_APPLET_APPEARANCE)));await pause(180);
 const js=code=>guest.webContents.executeJavaScript(code);const initial=await js('({bg:getComputedStyle(document.body).backgroundColor,color:getComputedStyle(document.body).color,font:getComputedStyle(document.documentElement).fontFamily,button:getComputedStyle(document.querySelector("#primary")).backgroundImage,radius:getComputedStyle(document.querySelector("#primary")).borderRadius,icons:document.querySelectorAll("svg[data-icon-library=hugeicons]").length,names:mousseApplet.iconNames,paths:Array.from(document.querySelector("[data-mousse-icon=plus]").querySelectorAll("path"),node=>node.getAttribute("d"))})');
 assert.equal(await js('getComputedStyle(document.querySelector("#plain")).borderRadius'),'6px');assert.equal(await js('getComputedStyle(document.querySelector("#nested")).backdropFilter'),'none');assert.equal(initial.bg,'rgb(27, 28, 35)');assert.equal(initial.color,'rgb(240, 240, 240)');assert.equal(initial.radius,'6px');assert.match(initial.button,/linear-gradient/);assert.equal(initial.icons,3);assert.equal(initial.names.length,25);assert.deepEqual(initial.paths,Add01Icon.filter(([tag])=>tag==='path').map(([,props])=>props.d));
 await js('document.querySelector("main").appendChild(mousseApplet.icon("Plus",{size:24,strokeWidth:2,label:"<img src=x onerror=alert(1)>"}))');assert.equal(await js('document.querySelector("main").lastElementChild.getAttribute("aria-label")'),'<img src=x onerror=alert(1)>');assert.equal(await js('document.querySelectorAll("img").length'),0);
 const scroll=await js('Array.from(document.querySelectorAll("#scroll,#nested"),node=>({width:getComputedStyle(node).scrollbarWidth,color:getComputedStyle(node).scrollbarColor,thumb:getComputedStyle(node,"::-webkit-scrollbar-thumb").backgroundColor,bar:getComputedStyle(node,"::-webkit-scrollbar").width}))');assert(scroll.every(x=>x.width==='thin'&&x.color==='rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)'&&x.bar==='6px'&&x.thumb==='rgba(0, 0, 0, 0)'),JSON.stringify(scroll));
 await js('document.querySelector("#nested").scrollTop=20');await pause(60);assert(await js('document.querySelector("#nested").classList.contains("mousse-scrolling")'));assert.notEqual(await js('getComputedStyle(document.querySelector("#nested")).scrollbarColor'),'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');await pause(1000);assert.equal(await js('document.querySelector("#nested").classList.contains("mousse-scrolling")'),false);
 await js('document.querySelector("#scroll").focus()');assert.notEqual(await js('getComputedStyle(document.querySelector("#scroll")).scrollbarColor'),'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');await js('document.querySelector("#scroll").blur()');
 const light={theme:'light',colorScheme:'light',fontFamily:'monospace',fontSize:'16px',reducedMotion:true,tokens:{'--surface-base':'#fafafa','--surface-strong':'#eeeeee','--text-primary':'#222222','--accent':'#0077cc','--accent-rgb':'0,119,204','--accent-pale-rgb':'0,119,204','--gradient-accent':'linear-gradient(135deg,#0077cc,#005599)','--theme-btn-radius':'9px'}};
 await js('window.appearanceEvents=0;document.addEventListener("mousse-appearance-change",()=>window.appearanceEvents++)');assert.equal(await js(APPLET_APPLY_APPEARANCE+'('+JSON.stringify(light)+')'),true);
 const changed=await js('({bg:getComputedStyle(document.body).backgroundColor,color:getComputedStyle(document.body).color,font:getComputedStyle(document.documentElement).fontFamily,size:getComputedStyle(document.documentElement).fontSize,radius:getComputedStyle(document.querySelector("#primary")).borderRadius,transition:getComputedStyle(document.querySelector("#primary")).transitionDuration,runs:userExecutions,event:appearanceEvents,theme:mousseApplet.appearance.theme,host:typeof window.mousse,node:typeof require})');assert.equal(changed.bg,'rgb(250, 250, 250)');assert.equal(changed.color,'rgb(34, 34, 34)');assert.equal(changed.font,'monospace');assert.equal(changed.size,'16px');assert.equal(changed.radius,'9px');assert.equal(changed.transition,'0s');assert.equal(changed.runs,1);assert.equal(changed.event,1);assert.equal(changed.theme,'light');assert.equal(changed.host,'undefined');assert.equal(changed.node,'undefined');
 assert.equal(await js(APPLET_APPLY_APPEARANCE+'('+JSON.stringify({...light,tokens:{'--accent':'url(https://example.com)'}})+')'),false);assert.equal(await js('mousseApplet.appearance.theme'),'light');
 await js('document.querySelector("[data-mousse-icon=plus]").setAttribute("data-icon-size","28")');await pause(50);assert.equal(await js('document.querySelector("[data-mousse-icon=plus] svg").getAttribute("width")'),'28');
 const exported=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});try{await exported.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(exportAppletHtml({...source,schemaVersion:1,title:'Export controls',description:'Appearance fixture'},light)));await pause(150);const frame=exported.webContents.mainFrame.frames[0];assert(frame);assert.equal(await frame.executeJavaScript('mousseApplet.appearance.theme'),'light');assert.equal(await frame.executeJavaScript('document.querySelectorAll("svg[data-icon-library=hugeicons]").length'),3);assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).backgroundColor'),'rgb(250, 250, 250)');assert.equal(await frame.executeJavaScript('getComputedStyle(document.querySelector("#plain")).borderRadius'),'9px');assert.equal(await frame.executeJavaScript('userExecutions'),1)}finally{exported.destroy()}
 console.log('Applet appearance passed: dark/light live theme, controls/forms, Hugeicons identity, safe DOM icons, nested thin idle/scroll/focus scrollbars despite source overrides, reduced motion, one user JS execution, no privileged bridge.');guest.destroy();app.quit();
 }catch(error){console.error(error);guest.destroy();app.exit(1)}
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
      [join(directory, 'probe.cjs'), directory, '--ozone-platform=x11'],
      { env, stdio: 'inherit' }
    )
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Appearance probe timed out'))
    }, 15000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error('Appearance probe failed: ' + code))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
