import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
const directory = await mkdtemp(join(tmpdir(), 'mousse-claude-usage-ui-'))
try {
  await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import{createRoot}from'react-dom/client';import{SubscriptionUsagePage}from'./src/renderer/components/SubscriptionUsagePage';
    window.fixture={unavailable:false,calls:0};window.mousse={providers:{getUsage:async()=>{fixture.calls++;return{fetchedAt:new Date().toISOString(),providers:[{id:'claude-subscription',label:'Claude Subscription',status:fixture.unavailable?'unavailable':'available',windows:fixture.unavailable?[]:[{id:'five_hour',label:'5-hour',remainingPercent:75,resetsAt:new Date(Date.now()+3600000).toISOString()},{id:'seven_day',label:'Weekly',remainingPercent:25}],message:fixture.unavailable?'Claude quota data is unavailable.':undefined}]}}}};
    createRoot(document.getElementById('root')).render(<SubscriptionUsagePage onClose={()=>{}}/>);
  `},outfile:join(directory,'renderer.js'),bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})
  await writeFile(join(directory,'index.html'),'<html><body><div id="root"></div><script src="renderer.js"></script></body></html>')
  await writeFile(join(directory,'main.cjs'),`
    const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{join}=require('node:path');app.setPath('userData',join(process.argv[2],'user-data'));const pause=ms=>new Promise(r=>setTimeout(r,ms));
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});try{await win.loadFile(join(process.argv[2],'index.html'));const js=s=>win.webContents.executeJavaScript(s);await pause(150);assert(await js('document.body.textContent.includes("Claude Subscription")'));assert.deepEqual(await js('Array.from(document.querySelectorAll("[role=progressbar]")).map(n=>n.getAttribute("aria-valuenow"))'),['75','25']);assert(await js('document.body.textContent.includes("Resets in")'));await js('fixture.unavailable=true;document.querySelector(".usage-heading button:last-child").click()');await pause(100);assert.equal(await js('fixture.calls'),2);assert.equal(await js('document.querySelectorAll("[role=progressbar]").length'),0);assert(await js('document.body.textContent.includes("Claude quota data is unavailable.")'));console.log('Claude Usage UI passed: provider visible, reported windows and reset time, refresh, honest unavailable state.');win.destroy();app.quit()}catch(error){console.error(error);win.destroy();app.exit(1)}});
  `)
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve,reject)=>{const child=spawn(electron,[join(directory,'main.cjs'),directory,'--ozone-platform=x11'],{env,stdio:'inherit'});const timer=setTimeout(()=>child.kill('SIGKILL'),20000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Usage UI check failed: '+code))})})
} finally {await rm(directory,{recursive:true,force:true})}
