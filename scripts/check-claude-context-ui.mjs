import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

const directory = await mkdtemp(join(tmpdir(), 'mousse-claude-context-ui-'))
try {
  await writeFile(
    join(directory, 'preload.cjs'),
    `require('electron').contextBridge.exposeInMainWorld('mousse', {platform:process.platform})`
  )
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ComposerFooter} from './src/renderer/components/ComposerFooter';
    import {useAppStore} from './src/renderer/stores/appStore';
    const measured={percent:20,used:20000,limit:100000,modelName:'claude-reported-model',source:'measured',processedTokens:30000,categories:[{label:'Conversation',color:'#aaa',tokens:20000}]};
    const unknown={percent:0,used:80,limit:0,modelName:'opus:low',source:'estimated',categories:[{label:'Conversation',color:'#aaa',tokens:80}]};
    const noop=()=>{};
    function Fixture(){const[provider,setProvider]=React.useState('claude-subscription');const[usage,setUsage]=React.useState(unknown);const[open,setOpen]=React.useState(false);
      return <><button id="known" onClick={()=>{setProvider('claude-subscription');setUsage(measured);setOpen(false)}}>Known</button><button id="api" onClick={()=>{setProvider('anthropic');setUsage(measured);setOpen(false)}}>API</button><button id="native-other" onClick={()=>{setProvider('antigravity');setOpen(false)}}>Other native</button>
      <ComposerFooter chatMode="agent" onChatModeChange={noop} enabledSkills={[]} providers={[{id:provider,label:provider,models:[{id:'opus:low',label:'Opus'}]}]} selectedProviderId={provider} selectedModelId="opus:low" modelMenuOpen={false} onModelMenuOpenChange={noop} onModelSelect={noop} onOpenSettings={noop} contextUsage={usage} contextOpen={open} onContextOpenChange={setOpen} onAttachClick={noop}/>
      <button id="settings-state" onClick={()=>document.body.dataset.settingsOpen=String(useAppStore.getState().settingsOpen)}>Read settings</button></>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `
    },
    outfile: join(directory, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.svg': 'dataurl', '.webp': 'dataurl', '.png': 'dataurl' }
  })
  await writeFile(
    join(directory, 'fixture.html'),
    '<html><body><div id="root"></div><script src="renderer.js"></script></body></html>'
  )
  await writeFile(
    join(directory, 'main.cjs'),
    `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const {join}=require('node:path');
    app.setPath('userData',join(process.argv[2],'user-data'));
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{preload:join(process.argv[2],'preload.cjs'),sandbox:true,contextIsolation:true}});
      win.webContents.on('console-message',event=>console.log('renderer',event.message));
      try{await win.loadFile(join(process.argv[2],'fixture.html'));await pause(100);const js=code=>win.webContents.executeJavaScript(code);const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await pause(30)};
        assert.equal(await js('document.querySelector(".context-usage-btn").getAttribute("aria-label")'),'Context usage, model capacity not reported yet');
        await click('.context-usage-btn');let text=await js('document.querySelector(".context-usage-popover").textContent');assert(text.includes('Model capacity not reported yet'));assert(text.includes('Unknown'));assert(!text.includes('0% of model context'));
        await click('[aria-label="Edit context compaction settings"]');await click('#settings-state');assert.equal(await js('document.body.dataset.settingsOpen'),'true');assert.equal(await js('location.hash'),'#settings-context-compaction');
        await click('#known');assert.equal(await js('document.querySelector(".context-usage-btn").getAttribute("aria-label")'),'Context usage 20% full');await click('.context-usage-btn');text=await js('document.querySelector(".context-usage-popover").textContent');assert(text.includes('claude-reported-model'));assert(text.includes('20% of model context'));assert(text.includes('20.0K / 100K'));assert(text.includes('30.0K tokens across model calls'));
        await click('#api');assert(await js('!!document.querySelector(".context-usage-btn")'));
        await click('#native-other');assert.equal(await js('!!document.querySelector(".context-usage-btn")'),false);
        console.log('Claude context UI passed: visible native meter, honest unknown capacity, measured model/tokens, context settings action, API meter retained.');win.destroy();app.quit();
      }catch(error){console.error(error);win.destroy();app.exit(1)}
    });
  `
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(
      electron,
      [
        join(directory, 'main.cjs'),
        directory,
        ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])
      ],
      { env, stdio: 'inherit' }
    )
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error('Claude context UI check failed: ' + code))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
