import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import { build } from 'esbuild'

// Mount the real project chat and composer; replace only the unrelated transcript renderer.
const directory = await mkdtemp(join(tmpdir(), 'mousse-composer-workspace-'))
try {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client'
      import { OrchestratorChat } from './src/renderer/components/OrchestratorChat'
      import { useAppStore } from './src/renderer/stores/appStore'
      const subscription = () => () => {}
      const projects = [{id:'a',name:'mousse',path:'/fixture/mousse'}, {id:'b',name:'Other project',path:'/fixture/other'}]
      window.fixture = { store:useAppStore, calls:[], errors:[], sequence:0 }
      window.addEventListener('error', event => fixture.errors.push(event.message))
      window.addEventListener('unhandledrejection', event => fixture.errors.push(String(event.reason)))
      const usage = {percent:0,used:0,limit:128000,source:'estimated',categories:[]}
      window.mousse = {
        platform:'linux',
        settings:{get:async()=>({provider:{llmProvider:'openai',model:'test'},integrations:{skills:{enabledSkills:[]}}}),
          getOptions:async()=>({llmProviders:[{id:'openai',label:'OpenAI',models:[{id:'test',label:'Test'}]}]}),onChanged:subscription},
        providers:{onChanged:subscription}, skills:{list:async()=>({skills:[]}),onChanged:subscription},
        projects:{open:async()=>{fixture.calls.push(['open']);return projects[1]}},
        threads:{
          create:async(_,projectId,opts)=>{
            fixture.calls.push(['create',projectId ?? null,opts]);
            if(fixture.createError) throw new Error('Unable to create draft')
            if(fixture.pendingCreate) await new Promise(resolve=>fixture.resumeCreate=resolve)
            return {id:'created-'+ ++fixture.sequence,name:'New Chat',projectId,worktreeEnabled:opts.worktreeEnabled,order:0}
          },
          setWorktreeEnabled:async(id,enabled)=>{
            fixture.calls.push(['worktree',id,enabled]);
            if(fixture.toggleError) throw new Error('Worktree unavailable')
            return {...useAppStore.getState().threads.find(t=>t.id===id),worktreeEnabled:enabled}
          },
          select:async(id)=>{fixture.calls.push(['select',id]);if(fixture.selectError) throw new Error('Unable to select draft')},
          setModel:async(id,modelOverride)=>({...useAppStore.getState().threads.find(t=>t.id===id),modelOverride})
        },
        queue:{list:async()=>[],onUpdated:subscription},
        orchestrator:{onTurnSteered:subscription,onQuestionsPending:subscription,onQuestionsCleared:subscription,
          onConnectionFailed:subscription,isTurnActive:async()=>false,getContextUsage:async()=>usage,
          sendToThread:async(id,request)=>{fixture.calls.push(['send',id,request.content]);return {queued:false}}
        }
      }
      fixture.reset = (thread=null) => {
        fixture.calls=[];fixture.selectError=false;fixture.createError=false;fixture.toggleError=false;fixture.pendingCreate=false;
        useAppStore.setState({activeThreadId:thread?.id ?? null,threads:thread?[thread]:[],projects,
          messages:[],loading:false,turnStates:{},composerDrafts:{},composerReferences:{},composerWorkspaceDrafts:{},browserElementAttachmentsByThread:{}})
      }
      fixture.reset()
      createRoot(document.getElementById('root')).render(<OrchestratorChat />)
    ` }, bundle: true, platform: 'browser', format: 'iife', write: false, outfile: join(directory,'fixture.js'),
    jsx: 'automatic', loader: { '.svg':'dataurl','.webp':'dataurl' }, define: {'process.env.NODE_ENV':'"production"'},
    plugins: [{name:'transcript',setup(builder){
      builder.onResolve({filter:/\.svg\?raw$/},args=>({path:new URL(args.path.replace('?raw',''), 'file://' + args.resolveDir + '/').pathname,namespace:'raw-svg'}))
      builder.onLoad({filter:/.*/,namespace:'raw-svg'},async args=>({loader:'text',contents:await readFile(args.path,'utf8')}))
      builder.onResolve({filter:/\/chat\/components\/MousseAgentChatShell$/},()=>({path:'shell',namespace:'fixture'}))
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'tsx',resolveDir:process.cwd(),contents:
        'export function MousseAgentChatShell({composer}) { return <div className="mousse-chat-shell">{composer}</div> }'}))
    }}]
  })
  for (const file of bundle.outputFiles) await writeFile(file.path,file.contents)
  const css = await readFile('src/renderer/styles/app.css','utf8')
  const globalCss = await readFile('src/renderer/styles/global.css','utf8')
  const formStyles = globalCss.slice(globalCss.indexOf('button {'), globalCss.indexOf('textarea:focus {'))
    + globalCss.slice(globalCss.indexOf('textarea:focus {'), globalCss.indexOf('}', globalCss.indexOf('textarea:focus {')) + 1)
  await writeFile(join(directory,'fixture.html'), `<html><head><link rel="stylesheet" href="fixture.css"><style>
    ${formStyles}
    ${css}
    :root{--surface-strong-rgb:32,32,34;--surface-base-rgb:20,20,22;--accent-rgb:170,140,200;
      --accent-pale-rgb:200,180,220;--accent:#b7a1d0;--text-primary:white;--text-secondary:#aaa}
    button,input,textarea,select{font:inherit}button{border:0;background:none;color:inherit}button:not(:disabled){cursor:pointer}
    body{margin:0;background:#141416;color:white;font:14px sans-serif}*{box-sizing:border-box;animation:none!important}
    #root{height:100vh}.mousse-chat-shell{display:flex;flex-direction:column;justify-content:center;height:100%}
  </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  await writeFile(join(directory,'check.cjs'),String.raw`
    const assert=require('node:assert/strict')
    const {writeFileSync}=require('node:fs')
    const {app,BrowserWindow}=require('electron')
    const pause=ms=>new Promise(r=>setTimeout(r,ms))
    app.whenReady().then(async()=>{
      const window=new BrowserWindow({width:900,height:650,show:false,webPreferences:{backgroundThrottling:false}})
      window.webContents.on("console-message",event=>{if(event.level==="error") console.error(event.message)})
      const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code)}catch(error){console.error("Renderer evaluation:",code);throw error}}
      const click=async selector=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await pause(50)}
      const choose=async value=>{await evaluate('(()=>{const s=document.querySelector("[aria-label=Project]");s.value='+JSON.stringify(value)+';s.dispatchEvent(new Event("change",{bubbles:true}))})()');await pause(50)}
      const prompt=async text=>{await evaluate('fixture.store.getState().setComposerDraft(fixture.store.getState().activeThreadId,'+JSON.stringify(text)+')');await pause(60)}
      const send=()=>click('.composer-action-btn-active')
      const calls=()=>evaluate('fixture.calls')
      const draft={id:'draft',name:'New Chat',projectId:'a',order:0}
      try{
        await window.loadFile(__dirname+'/fixture.html');await pause(300)
        for(const platform of ['linux','win32','darwin']){
          await evaluate('window.mousse.platform='+JSON.stringify(platform)+';fixture.reset()');await pause(100)
          assert.equal(await evaluate('document.querySelector("[aria-label=Project]").value'),'')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree input").disabled'),true)
          await prompt('Build the feature');await choose('a');await click('[aria-label="Start in a worktree"]')
          assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Build the feature')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-device").textContent'),'This computer')
          await send()
          assert.deepEqual((await calls()).map(c=>c[0]),['create','select','send'])
          assert.deepEqual((await calls())[0],['create','a',{worktreeEnabled:true}])
          assert.equal((await calls())[2][2],'Build the feature')
          assert.equal(await evaluate('!!document.querySelector(".composer-workspace-toolbar")'),false)
          await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(100)
          assert.equal(await evaluate('document.querySelector("[aria-label=Project]").value'),'a')
          await click('[aria-label="Start in a worktree"]');await prompt('Use this draft');await send()
          assert.deepEqual((await calls()).map(c=>c[0]),['worktree','send'])
          await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(100)
          await prompt('Move to other project');await choose('b');await send()
          assert.deepEqual((await calls())[0],['create','b',{worktreeEnabled:false}])
          assert.equal((await calls()).at(-1)[2],'Move to other project')
          console.log('PASS: '+platform+' project selection, first-send worktree creation, existing-draft toggle, and project change')
        }
        await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(100)
        await click('[aria-label="Start in a worktree"]');await prompt('Keep my prompt')
        await evaluate('fixture.toggleError=true');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Keep my prompt')
        assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'),'Worktree unavailable')
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        await evaluate('fixture.reset()');await pause(100);await choose('__open_project__')
        assert.equal(await evaluate('document.querySelector("[aria-label=Project]").value'),'b')
        await choose('a');await click('[aria-label="Start in a worktree"]');await choose('')
        assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree input").checked'),false)
        await choose('a');await prompt('Pending navigation');await evaluate('fixture.pendingCreate=true');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").disabled'),true)
        await evaluate('fixture.store.setState({activeThreadId:"elsewhere",threads:[{id:"elsewhere",name:"Existing",startedAt:"now"}],composerDrafts:{elsewhere:"Other prompt"}});fixture.resumeCreate()');await pause(100)
        assert.equal(await evaluate('fixture.store.getState().activeThreadId'),'elsewhere')
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        await evaluate('fixture.reset('+JSON.stringify(draft)+');fixture.selectError=true');await pause(100)
        await prompt('Recover after project change');await choose('b')
        await evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File(["notes"],"notes.txt",{type:"text/plain"}));document.querySelector(".composer").dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:transfer}))})()');await pause(60)
        await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Recover after project change')
        assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'),'Unable to select draft')
        assert.equal(await evaluate('document.querySelector(".composer-attachments").textContent.includes("notes.txt")'),true)
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        console.log('PASS: project change preserves text and file attachments after a selection failure')
        console.log('PASS: creation navigation guard, pending send lock, open-project picker, and worktree failure recovery')
        // Draft choices survive both thread switching and profile-local persistence.
        await evaluate('fixture.reset('+JSON.stringify(draft)+');fixture.store.getState().activateProfile("toolbar-profile")');await pause(100)
        await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(60)
        await choose('b');await click('[aria-label="Start in a worktree"]')
        await evaluate('fixture.store.getState().switchToThread("elsewhere");fixture.store.getState().switchToThread("draft")');await pause(60)
        assert.equal(await evaluate('document.querySelector("[aria-label=Project]").value'),'b')
        assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree input").checked'),true)
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("mousse-profile-toolbar-profile-workspace")).composerWorkspaceDrafts.draft.projectId'),'b')
        await evaluate('fixture.store.getState().activateProfile("other-profile")');await pause(60)
        assert.equal(await evaluate('Object.keys(fixture.store.getState().composerWorkspaceDrafts).length'),0)
        await evaluate('fixture.store.getState().activateProfile("toolbar-profile");fixture.store.setState({activeThreadId:"draft",threads:['+JSON.stringify(draft)+'],projects:[{id:"a",name:"mousse"},{id:"b",name:"Other project"}]})');await pause(60)
        assert.equal(await evaluate('document.querySelector("[aria-label=Project]").value'),'b')
        console.log('PASS: draft workspace choices survive navigation and remain isolated by profile')
        window.setSize(420,650);await pause(100)
        assert.equal(await evaluate('(()=>{const toolbar=document.querySelector(".composer-workspace-toolbar").getBoundingClientRect();return [...document.querySelectorAll(".composer-workspace-toolbar select,.composer-workspace-worktree")].every(e=>{const r=e.getBoundingClientRect();return r.left>=toolbar.left&&r.right<=toolbar.right})})()'),true)
        assert.deepEqual(await evaluate('fixture.errors'),[])
        window.setSize(900,650);await pause(100)
        await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(60)
        assert.equal(await evaluate('document.querySelector("[aria-label=Project]").value'),'a')
        window.show();await pause(150)
        const image=await window.webContents.capturePage();writeFileSync('/tmp/mousse-composer-workspace.png',image.toPNG())
        console.log('PASS: narrow toolbar layout; screenshot /tmp/mousse-composer-workspace.png')
      }finally{window.destroy()}
      app.quit()
    }).catch(error=>{console.error(error);app.exit(1)})
  `)
  const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolve,reject)=>{
    const child=spawn(electron,[join(directory,'check.cjs'),'--ozone-platform=x11'],{env,stdio:'inherit'})
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Composer workspace check timed out'))},45_000)
    child.once('error',error=>{clearTimeout(timeout);reject(error)})
    child.once('exit',code=>{clearTimeout(timeout);resolve(code)})
  })
  assert.equal(code,0,'Composer workspace Chromium check failed')
}finally{await rm(directory,{recursive:true,force:true})}
