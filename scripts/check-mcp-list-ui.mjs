import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
const directory = await mkdtemp(join(tmpdir(), 'mousse-mcp-list-'))
try {
  await build({
    stdin: {
      loader: 'tsx',
      resolveDir: process.cwd(),
      contents: `
 import React from 'react';import{createRoot}from'react-dom/client';import{IntegrationsWorkspace}from'./src/renderer/components/integrations/IntegrationsWorkspace';import{IsolatedIntegrationPlatformClient}from'./tests/fixtures/agent-platform/integration-editor-client';
 const client=new IsolatedIntegrationPlatformClient();const original=client.testMcp.bind(client);const login=client.beginMcpAuth.bind(client);window.fixture={client,tests:[],signed:new Set(),failure:false,pending:false};
 client.testMcp=async p=>{window.fixture.tests.push(p);const record=await client.readMcp(p);if(record.server.transport==='http'&&!window.fixture.signed.has(p.installationId))return{success:false,errorCategory:'auth-required',error:'Sign-in required'};return original(p)};
 client.beginMcpAuth=async p=>{if(window.fixture.failure)return{success:false,error:'The browser could not be opened.'};if(window.fixture.pending){client.authOutcome='pending';return login(p)};window.fixture.signed.add(p.installationId);return{success:true}};
 function App(){const[profile,setProfile]=React.useState('a');return <><button id="switch" onClick={()=>setProfile('b')}>Switch</button><IntegrationsWorkspace client={client} profileId={profile}/></>};createRoot(document.getElementById('root')).render(<App/>);
 `
    },
    outfile: join(directory, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' }
  })
  await writeFile(
    join(directory, 'index.html'),
    '<html><head><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>'
  )
  await writeFile(
    join(directory, 'main.cjs'),
    `
 const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{join}=require('node:path');app.setPath('userData',join(process.argv[2],'user-data'));const pause=ms=>new Promise(r=>setTimeout(r,ms));
 app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});win.webContents.on('console-message',event=>console.log('renderer',event.message));try{await win.loadFile(join(process.argv[2],'index.html'));const js=s=>win.webContents.executeJavaScript(s);const wait=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await pause(30)}throw Error('Timed out: '+code)};const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await pause(30)};const input=async(name,value)=>{await js('(()=>{const input=Array.from(document.querySelectorAll("label")).find(l=>l.textContent.includes('+JSON.stringify(name)+')).querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}))})()');await pause(30)};
 const rowButton=text=>'Array.from(document.querySelectorAll("[data-mcp-card] button")).find(b=>b.textContent==='+JSON.stringify(text)+')';const card='document.querySelector("[data-mcp-card]").textContent';const menu=async item=>{await click('[aria-label="More actions for Remote"]');await js('Array.from(document.querySelectorAll(".row-menu-item")).find(b=>b.textContent==='+JSON.stringify(item)+').click()');await pause(30)};const toggle=async()=>{await click('[role=switch][aria-label="Remote"]');await wait('!document.querySelector("[role=switch][aria-label=Remote]").disabled')};
 await wait('!!document.querySelector("[data-action=add-mcp]")');await click('[data-action=add-mcp]');await input('Name','Remote');await js('Array.from(document.querySelectorAll("[data-mcp-form] [role=radio]")).find(b=>b.textContent==="Remote").click()');await pause(30);await input('Server URL','https://example.invalid/mcp');await click('button[type=submit]');
 await wait('!!'+rowButton('Sign in'));assert.equal(await js('window.fixture.tests.length'),1,'Adding automatically tests once');assert(await js(card+'.includes("Needs sign-in")'));
 await js(rowButton('Sign in')+'.click()');await wait(card+'.includes("Connected")');assert.equal(await js('Array.from(window.fixture.client.servers.values())[0].record.server.authMode'),'oauth','Explicit listing login persists OAuth selection');assert.equal(await js('window.fixture.tests.length'),2,'Sign-in automatically retests');
 await menu('Edit');await wait('!!document.querySelector("[data-mcp-form]")');await input('Server URL','https://example.invalid/updated');await click('button[type=submit]');await wait('window.fixture.tests.length===3');await menu('Edit');await wait('!!document.querySelector("[data-mcp-form]") && !document.querySelector("[data-mcp-form] fieldset").disabled');await js('window.fixture.failure=true;Array.from(document.querySelectorAll("[data-mcp-form] button")).find(b=>b.textContent==="Sign in").click()');await wait('document.body.textContent.includes("The browser could not be opened.")');await click('[aria-label=Close]');
 await js('window.fixture.failure=false;window.fixture.signed.clear()');await toggle();await toggle();await wait('!!'+rowButton('Sign in'));await js('window.fixture.pending=true');await js(rowButton('Sign in')+'.click()');await wait('!!document.querySelector("[data-mcp-card] [aria-label^=Cancel]")');await click('#switch');await wait('document.querySelector("[data-integrations-workspace]").dataset.profileId==="b"');await wait('window.fixture.client.pendingAuth.size===0');assert.equal(await js('document.querySelectorAll("[data-mcp-card]").length'),0,'Profile switch excludes stale personal rows');
 console.log('MCP listing UI passed: automatic add/test, row sign-in, OAuth selection, retest, editor launch failure, pending cancellation/profile isolation.');win.destroy();app.quit()}catch(e){console.error(e);win.destroy();app.exit(1)}});
 `
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(
      electron,
      [join(directory, 'main.cjs'), directory, '--ozone-platform=x11'],
      { env, stdio: 'inherit' }
    )
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(Error('MCP UI check failed: ' + code))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
