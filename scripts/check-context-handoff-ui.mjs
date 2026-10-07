import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

const directory = await mkdtemp(join(tmpdir(), 'mousse-context-handoff-ui-'))
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
    import {MessageList} from './src/renderer/chat/components/agent-elements/message-list';
    import {mousseToUIMessages} from './src/renderer/chat/adapters/mousseToUI';
    const msg=(id,role,content,extra={})=>({id,role,content,timestamp:'2026-10-07T00:00:00Z',...extra});
    const messages=[msg('old','assistant','Previous answer'),msg('user','user','New request'),msg('handoff','assistant','gpt-6.1-sol → opus:medium',{kind:'context_handoff',contextHandoff:{from:{provider:'openai-codex',model:'gpt-6.1-sol'},to:{provider:'claude-subscription',model:'opus:medium'}}}),msg('answer','assistant','New answer')];
    createRoot(document.getElementById('root')).render(<MessageList messages={mousseToUIMessages(messages)} status="ready"/>);
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
        assert.equal(await js('document.querySelectorAll("[role=status]").length'),1);
        assert.equal(await js('document.querySelector("[role=status]").textContent'),'gpt-6.1-sol→opus:medium');
        assert.equal(await js('document.querySelectorAll("[role=status] img, [role=status] svg").length'),2);
        const text=await js('document.body.textContent');assert(text.indexOf('New request')<text.indexOf('gpt-6.1-sol'));assert(text.indexOf('opus:medium')<text.indexOf('New answer'));
        console.log('Context handoff UI passed: one compact marker, old model, arrow, new model, between new prompt and answer.');win.destroy();app.quit();
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
      code === 0 ? resolve() : reject(new Error('Context handoff UI check failed: ' + code))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
