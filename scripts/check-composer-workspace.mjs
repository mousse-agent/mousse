import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { build } from 'esbuild'

// Mount the real project chat and composer; replace only the unrelated transcript renderer.
const directory = await mkdtemp(join(tmpdir(), 'mousse-composer-workspace-'))
try {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client'
      import { OrchestratorChat } from './src/renderer/components/OrchestratorChat'
      import { MainViewTabs } from './src/renderer/components/MainViewTabs'
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
        projects:{open:async()=>{fixture.calls.push(['open']);return projects[1]},listThreads:async()=>[]},
        chatReferences:{resolve:async(reference)=>{if(fixture.referenceError)throw new Error('Reference unavailable');return {...reference,metadataPath:'/fixture/meta.json'}}},
        workspace:{getStatus:async()=>({})},
        app:{getActiveProjectPath:async(id)=>{const project=projects.find(p=>p.id===useAppStore.getState().threads.find(t=>t.id===id)?.projectId);if(fixture.pendingPath)await new Promise(resolve=>fixture.resumePath=resolve);return project?.path ?? null}},
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
          setModel:async(id,modelOverride)=>{if(fixture.modelError) throw new Error('Unable to save model');return {...useAppStore.getState().threads.find(t=>t.id===id),modelOverride}}
        },
        queue:{list:async()=>[],onUpdated:subscription},
        orchestrator:{onTurnSteered:subscription,onQuestionsPending:subscription,onQuestionsCleared:subscription,
          onConnectionFailed:subscription,isTurnActive:async()=>false,getContextUsage:async()=>usage,
          sendToThread:async(id,request)=>{fixture.calls.push(['send',id,request.content]);return fixture.sendError ? {requestAcknowledged:false,error:{code:'delivery_rejected',message:'Delivery rejected'}} : {queued:false}}
        }
      }
      fixture.reset = (thread=null) => {
        fixture.calls=[];fixture.selectError=false;fixture.createError=false;fixture.toggleError=false;fixture.pendingCreate=false;fixture.modelError=false;fixture.sendError=false;fixture.referenceError=false;fixture.pendingPath=false;
        useAppStore.setState({activeThreadId:thread?.id ?? null,threads:thread?[thread]:[],projects,
          messages:[],loading:false,mainView:'agents',turnStates:{},composerDrafts:{},composerReferences:{},composerWorkspaceDrafts:{},browserElementAttachmentsByThread:{}})
      }
      fixture.reset()
      createRoot(document.getElementById('root')).render(<><MainViewTabs /><OrchestratorChat /></>)
    ` }, bundle: true, platform: 'browser', format: 'iife', write: false, outfile: join(directory,'fixture.js'),
    jsx: 'automatic', loader: { '.svg':'dataurl','.webp':'dataurl' }, define: {'process.env.NODE_ENV':'"production"'}, minify: true,
    plugins: [{name:'transcript',setup(builder){
      builder.onResolve({filter:/\.svg\?raw$/},args=>({path:resolve(args.resolveDir, args.path.replace('?raw','')),namespace:'raw-svg'}))
      builder.onLoad({filter:/.*/,namespace:'raw-svg'},async args=>({loader:'text',contents:await readFile(args.path,'utf8')}))
      builder.onResolve({filter:/\/chat\/components\/MousseAgentChatShell$/},()=>({path:'shell',namespace:'fixture'}))
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'tsx',resolveDir:process.cwd(),contents:
        'export function MousseAgentChatShell({composer}) { return <div className="mousse-chat-shell">{composer}</div> }'}))
    }}]
  })
  for (const file of bundle.outputFiles) await writeFile(file.path,file.contents)
  const css = await readFile('src/renderer/styles/app.css','utf8')
  const globalCss = await readFile('src/renderer/styles/global.css','utf8')
  const blackTheme = await readFile('src/renderer/styles/themes/blacksphere-plus.css','utf8')
  const formStyles = globalCss.slice(globalCss.indexOf('button {'), globalCss.indexOf('textarea:focus {'))
    + globalCss.slice(globalCss.indexOf('textarea:focus {'), globalCss.indexOf('}', globalCss.indexOf('textarea:focus {')) + 1)
  await writeFile(join(directory,'fixture.html'), `<html data-theme="blacksphere-plus"><head><link rel="stylesheet" href="fixture.css"><style>
    ${formStyles}
    ${css}
    :root{--surface-strong-rgb:32,32,34;--surface-base-rgb:20,20,22;--accent-rgb:170,140,200;
      --accent-pale-rgb:200,180,220;--accent:#b7a1d0;--text-primary:white;--text-secondary:#aaa;--border:#343238;--surface-soft-rgb:35,35,38;--surface-elevated-rgb:40,40,42;--floating-surface:#202024}
    ${blackTheme}
    button,input,textarea,select{font:inherit}button{border:0;background:none;color:inherit}button:not(:disabled){cursor:pointer}
    body{margin:0;background:var(--surface-base);color:white;font:14px sans-serif}*{box-sizing:border-box;animation:none!important}
    #root{height:100vh}.mousse-chat-shell{display:flex;flex-direction:column;justify-content:center;height:100%}
  </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  await writeFile(join(directory,'check.cjs'),String.raw`
    const assert=require('node:assert/strict')
    const {writeFileSync}=require('node:fs')
    const {join}=require('node:path')
    const {tmpdir}=require('node:os')
    const {app,BrowserWindow}=require('electron')
    const pause=ms=>new Promise(r=>setTimeout(r,ms))
    app.whenReady().then(async()=>{
      const window=new BrowserWindow({width:900,height:650,show:false,webPreferences:{backgroundThrottling:false}})
      window.webContents.on("console-message",event=>{if(event.level==="error") console.error(event.message)})
      const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code)}catch(error){console.error("Renderer evaluation:",code);throw error}}
      const click=async selector=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await pause(50)}
      const choose=async value=>{
        await click('.composer-workspace-project')
        await evaluate('Array.from(document.querySelectorAll(".composer-workspace-menu-item")).find(item=>item.dataset.projectId==='+JSON.stringify(value)+').click()')
        await pause(50)
      }
      const key=async keyName=>{
        const keyCode=({ArrowDown:'Down',ArrowUp:'Up',Enter:'Return'})[keyName] ?? keyName
        window.webContents.sendInputEvent({type:'keyDown',keyCode})
        if(keyName==='Enter') window.webContents.sendInputEvent({type:'char',keyCode:'\r'})
        window.webContents.sendInputEvent({type:'keyUp',keyCode});await pause(60)
      }
      const prompt=async text=>{await evaluate('fixture.store.getState().setComposerDraft(fixture.store.getState().activeThreadId,'+JSON.stringify(text)+')');await pause(60)}
      const send=()=>click('.composer-action-btn-active')
      const calls=()=>evaluate('fixture.calls')
      const draft={id:'draft',name:'New Chat',projectId:'a',order:0}
      try{
        await window.loadFile(__dirname+'/fixture.html');await pause(300)
        for(const platform of ['linux','win32','darwin']){
          await evaluate('window.mousse.platform='+JSON.stringify(platform)+';fixture.reset()');await pause(100)
          assert.equal(await evaluate('document.querySelector(".composer-workspace-project").dataset.projectId'),'')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree").disabled'),true)
          assert.equal(await evaluate('!!document.querySelector(".composer-workspace-toolbar select,.composer-workspace-toolbar input")'),false)
          assert.equal(await evaluate('!!document.querySelector(".composer-workspace-worktree .lucide-git-branch")'),true)
          await click('.composer-workspace-project')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-menu").parentElement===document.body'),true)
          assert.equal(await evaluate('document.querySelector(".composer-workspace-menu [aria-checked=true]").textContent'),'No project')
          await key('Escape')
          assert.equal(await evaluate('document.activeElement===document.querySelector(".composer-workspace-project")'),true)
          assert.equal(await evaluate('!!document.querySelector(".composer-workspace-menu")'),false)
          await key('ArrowDown');await key('ArrowDown');await key('Enter')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-project").dataset.projectId'),'a')
          await key('ArrowUp');await key('Home');await key('ArrowDown');await key('Enter')
          await click('.composer-workspace-project')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-menu [aria-checked=true]").textContent'),'mousse')
          await evaluate('document.querySelector(".composer-input").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');await pause(40)
          assert.equal(await evaluate('!!document.querySelector(".composer-workspace-menu")'),false)
          await prompt('Build the feature');await choose('a');await click('[aria-label="Start in a worktree"]')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree").getAttribute("aria-pressed")'),'true')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree").classList.contains("active")'),true)
          await click('.composer-workspace-worktree')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree").getAttribute("aria-pressed")'),'false')
          await click('.composer-workspace-worktree')
          assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Build the feature')
          assert.equal(await evaluate('document.querySelector(".composer-workspace-device").textContent'),'This computer')
          await send()
          assert.deepEqual((await calls()).map(c=>c[0]),['create','select','send'])
          assert.deepEqual((await calls())[0],['create','a',{worktreeEnabled:true}])
          assert.equal((await calls())[2][2],'Build the feature')
          assert.equal(await evaluate('!!document.querySelector(".composer-workspace-toolbar")'),false)
          await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(100)
          assert.equal(await evaluate('document.querySelector(".composer-workspace-project").dataset.projectId'),'a')
          await click('[aria-label="Start in a worktree"]');await prompt('Use this draft');await send()
          assert.deepEqual((await calls()).map(c=>c[0]),['worktree','send'])
          await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(100)
          await prompt('Move to other project');await choose('b');await send()
          assert.deepEqual((await calls())[0],['create','b',{worktreeEnabled:false}])
          assert.equal((await calls()).at(-1)[2],'Move to other project')
          console.log('PASS: '+platform+' themed menu keyboard/outside dismissal, icon toggle, project selection, first-send worktree creation, existing-draft toggle, and project change')
        }
        await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(100)
        await click('[aria-label="Start in a worktree"]');await prompt('Keep my prompt')
        await evaluate('fixture.toggleError=true');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Keep my prompt')
        assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'),'Worktree unavailable')
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        await evaluate('fixture.reset()');await pause(100);await choose('__open_project__')
        assert.equal(await evaluate('document.querySelector(".composer-workspace-project").dataset.projectId'),'b')
        await choose('a');await click('[aria-label="Start in a worktree"]');await choose('')
        assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree").getAttribute("aria-pressed")'),'false')
        await choose('a');await prompt('Pending navigation');await evaluate('fixture.pendingCreate=true');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").disabled'),true)
        await evaluate('fixture.store.setState({activeThreadId:"elsewhere",threads:[{id:"elsewhere",name:"Existing",startedAt:"now"}],composerDrafts:{elsewhere:"Other prompt"}});fixture.resumeCreate()');await pause(100)
        assert.equal(await evaluate('fixture.store.getState().activeThreadId'),'elsewhere')
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        await evaluate('fixture.reset('+JSON.stringify(draft)+');fixture.selectError=true');await pause(100)
        await prompt('Recover after project change');await choose('b')
        await evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File(["notes"],"notes.txt",{type:"text/plain"}));const input=document.querySelector(".composer-file-input");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}))})()');await pause(60)
        await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Recover after project change')
        assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'),'Unable to select draft')
        assert.equal(await evaluate('document.querySelector(".composer-attachments").textContent.includes("notes.txt")'),true)
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        console.log('PASS: project change preserves text and file attachments after a selection failure')
        console.log('PASS: creation navigation guard, pending send lock, open-project picker, and worktree failure recovery')
        await evaluate('fixture.reset();fixture.createError=true');await pause(100)
        await choose('b');await prompt('Recover after creation failure');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Recover after creation failure')
        assert.equal(await evaluate('document.querySelector(".composer-workspace-project").dataset.projectId'),'b')
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        await evaluate('fixture.reset('+JSON.stringify(draft)+');fixture.modelError=true');await pause(100)
        await choose('b');await prompt('Recover after model failure');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Recover after model failure')
        assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'),'Unable to save model')
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        await evaluate('fixture.reset('+JSON.stringify(draft)+');fixture.sendError=true');await pause(100)
        await choose('b');await prompt('Recover after rejected send');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Recover after rejected send')
        assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'),'[delivery_rejected] Delivery rejected')
        assert.equal(await evaluate('fixture.store.getState().composerDrafts.draft'),undefined)
        console.log('PASS: creation/model failures and structured send rejection preserve the exact staged draft')
        await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(100)
        await prompt('Prompt with references')
        await evaluate('(()=>{const transfer=new DataTransfer();transfer.setData("application/x-mousse-reference",JSON.stringify({id:"project:a",kind:"project",title:"mousse",projectId:"a"}));document.querySelector(".composer").dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:transfer}))})()');await pause(100)
        assert.equal(await evaluate('document.querySelector(".composer-reference-link").textContent'),'mousse')
        await choose('b');await evaluate('fixture.selectError=true');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Prompt with references')
        assert.equal(await evaluate('fixture.store.getState().composerReferences[fixture.store.getState().activeThreadId][0].projectId'),'a')
        assert.equal(await evaluate('fixture.store.getState().composerReferences.draft'),undefined)
        await evaluate('fixture.selectError=false;fixture.referenceError=true');await send()
        assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'),'Reference unavailable')
        assert.equal((await calls()).some(c=>c[0]==='send'),false)
        await evaluate('fixture.referenceError=false;fixture.sendError=true');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'Prompt with references')
        assert.equal(await evaluate('fixture.store.getState().composerReferences[fixture.store.getState().activeThreadId].length'),1)
        assert.equal((await calls()).at(-1)[2].includes('Mousse references data='),true)
        await evaluate('fixture.sendError=false');await send()
        assert.equal(await evaluate('document.querySelector(".composer-input").value'),'')
        assert.equal(await evaluate('!!document.querySelector(".composer-reference-link")'),false)
        console.log('PASS: dropped references follow project changes, survive resolution/delivery failure, and reach the prompt')
        await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(120)
        await evaluate('fixture.store.getState().setMainView("files");fixture.pendingPath=true;fixture.store.getState().upsertThread({id:"other",name:"Other",projectId:"b"});fixture.store.getState().switchToThread("other")');await pause(100)
        assert.equal(await evaluate('fixture.store.getState().mainView'),'files')
        await evaluate('fixture.resumePath()');await pause(100)
        assert.equal(await evaluate('fixture.store.getState().mainView'),'files')
        await evaluate('fixture.reset()');await pause(120)
        assert.equal(await evaluate('fixture.store.getState().mainView'),'agents')
        console.log('PASS: Files remains selected during a pending project-path lookup')
        // Draft choices survive both thread switching and profile-local persistence.
        await evaluate('fixture.reset('+JSON.stringify(draft)+');fixture.store.getState().activateProfile("toolbar-profile")');await pause(100)
        await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(60)
        await choose('b');await click('[aria-label="Start in a worktree"]')
        await evaluate('fixture.store.getState().switchToThread("elsewhere");fixture.store.getState().switchToThread("draft")');await pause(60)
        assert.equal(await evaluate('document.querySelector(".composer-workspace-project").dataset.projectId'),'b')
        assert.equal(await evaluate('document.querySelector(".composer-workspace-worktree").getAttribute("aria-pressed")'),'true')
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("mousse-profile-toolbar-profile-workspace")).composerWorkspaceDrafts.draft.projectId'),'b')
        await evaluate('fixture.store.getState().activateProfile("other-profile")');await pause(60)
        assert.equal(await evaluate('Object.keys(fixture.store.getState().composerWorkspaceDrafts).length'),0)
        await evaluate('fixture.store.getState().activateProfile("toolbar-profile");fixture.store.setState({activeThreadId:"draft",threads:['+JSON.stringify(draft)+'],projects:[{id:"a",name:"mousse"},{id:"b",name:"Other project"}]})');await pause(60)
        assert.equal(await evaluate('document.querySelector(".composer-workspace-project").dataset.projectId'),'b')
        console.log('PASS: draft workspace choices survive navigation and remain isolated by profile')
        window.setSize(420,650);await pause(100)
        assert.equal(await evaluate('(()=>{const toolbar=document.querySelector(".composer-workspace-toolbar").getBoundingClientRect();return [...document.querySelectorAll(".composer-workspace-project,.composer-workspace-worktree")].every(e=>{const r=e.getBoundingClientRect();return r.left>=toolbar.left&&r.right<=toolbar.right})})()'),true)
        await click('.composer-workspace-project')
        assert.equal(await evaluate('(()=>{const r=document.querySelector(".composer-workspace-menu").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'),true)
        await key('Escape')
        assert.deepEqual(await evaluate('fixture.errors'),[])
        window.setSize(900,650);await pause(100)
        await evaluate('fixture.reset('+JSON.stringify(draft)+')');await pause(60)
        assert.equal(await evaluate('document.querySelector(".composer-workspace-project").dataset.projectId'),'a')
        await click('.composer-workspace-worktree')
        await click('.composer-workspace-project')
        assert(await evaluate('parseFloat(getComputedStyle(document.querySelector(".composer-workspace-toolbar")).borderTopWidth)>=0.5'))
        const border=await evaluate('getComputedStyle(document.querySelector(".composer-workspace-toolbar")).borderTopColor')
        assert.notEqual(border,'rgba(0, 0, 0, 0)')
        assert.notEqual(border,'rgb(0, 0, 0)')
        console.log('PASS: black theme toolbar border '+border+' and viewport-clamped themed menu')
        window.show();await pause(150)
        const image=await window.webContents.capturePage();const screenshot=join(tmpdir(),'mousse-composer-workspace.png');writeFileSync(screenshot,image.toPNG())
        console.log('PASS: narrow toolbar layout; screenshot '+screenshot)
      }finally{window.destroy()}
      app.quit()
    }).catch(error=>{console.error(error);app.exit(1)})
  `)
  const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolve,reject)=>{
    const child=spawn(electron,[join(directory,'check.cjs'),...(process.platform==='linux'?['--ozone-platform=x11']:[])],{env,stdio:'inherit'})
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Composer workspace check timed out'))},45_000)
    child.once('error',error=>{clearTimeout(timeout);reject(error)})
    child.once('exit',code=>{clearTimeout(timeout);resolve(code)})
  })
  assert.equal(code,0,'Composer workspace Chromium check failed')
}finally{await rm(directory,{recursive:true,force:true})}
