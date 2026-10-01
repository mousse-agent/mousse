import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import { build } from 'esbuild'

// Exercise real App, stores, chat UI, managed-browser viewer and xterm. Monaco's
// network loader is replaced by an editor API harness; all resource logic is real.
const directory = await mkdtemp(join(tmpdir(), 'mousse-agent-chats-'))
try {
  const bundle = await build({
    stdin: { resolveDir: new URL('..', import.meta.url).pathname, loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client'
      import App from './src/renderer/App'
      import { useAppStore } from './src/renderer/stores/appStore'
      import { useChatsStore } from './src/renderer/stores/chatsStore'
      import { confirmNavigation } from './src/renderer/services/navigationGuards'
      const subscription = () => () => {}
      const clone = value => JSON.parse(JSON.stringify(value))
      const now = '2026-10-01T12:00:00Z'
      const agents = ['Scout','Forge','Pixel'].map((name,index)=>({id:'agent-'+index,name,slug:name.toLowerCase(),purpose:'Fixture agent',definitionRevision:'r1',deviceId:'local',available:true}))
      const owner = {id:'owner',kind:'person',name:'You'}
      const participant = agent => ({id:agent.id,kind:'agent',name:agent.name,slug:agent.slug,definitionId:agent.id,deviceId:'local'})
      const group = {id:'billing',kind:'group',name:'billing-launch',threadId:'group-thread',projectId:'smile',participants:[owner,...agents.slice(0,2).map(participant)],createdAt:now,updatedAt:now,messages:[{id:'one',participantId:'agent-0',text:'I checked the billing page. @forge can implement the change.',createdAt:now,status:'completed'},{id:'two',participantId:'agent-1',text:'I will update the shared file and check the browser.',createdAt:now,status:'completed'}]}
      const direct = {id:'scout-dm',kind:'direct',name:'Scout',threadId:'dm-thread',participants:[owner,participant(agents[0])],createdAt:now,updatedAt:now,messages:[]}
      window.fixture={store:useAppStore,chats:useChatsStore,errors:[],calls:[],browserPending:[],agents,conversations:{billing:group,'scout-dm':direct},decorations:[],confirmNavigation,confirmed:0,
        projects:[{id:'smile',name:'smiletrack',path:'/fixture',order:0}],threads:[{id:'loose',name:'Investigate startup',createdAt:now,updatedAt:now,order:0}],file:{path:'src/billing.ts',content:'export const ready = false\\n',revision:'r1'}}
      window.confirm=()=>{window.fixture.confirmed++;return false}
      window.addEventListener('error',event=>fixture.errors.push(event.message))
      window.addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)))
      const presence=(kind,id,cursor)=>({clientId:'viewer-two-'+kind,participant:{id:'owner-2',kind:'person',name:'Second viewer',color:'#52bbb6'},target:{kind,id},cursor,updatedAt:Date.now(),expiresAt:Date.now()+10000})
      const resources=groupId=>({profileId:'default',groupId,threadId:'group-thread',viewerClientId:'viewer-one',sequence:1,
        browsers:[{mode:'managed',session:{id:'browser-one',lifecycle:'open'},tabs:[],connection:'connected',history:[],artifacts:[],updatedAt:now,observation:{tabId:'tab-one',generation:1,observationId:'obs-one',title:'Billing preview',url:'https://billing.example.test/preview',viewport:{cssWidth:800,cssHeight:600},screenshot:{artifactId:'screenshot',pixelWidth:800,pixelHeight:600,cssToImageScaleX:2,cssToImageScaleY:2,cropOriginCss:{x:100,y:50}}}}],browserControls:{},
        terminals:[{id:'terminal-one',threadId:'group-thread',title:'Shared shell',alive:true,columns:80,rows:24}],files:[fixture.file],presence:[presence('browser','browser-one',{kind:'browser',tabId:'tab-one',generation:1,x:120,y:100}),presence('terminal','terminal-one',{kind:'terminal',column:10,row:4}),presence('file','src/billing.ts',{kind:'file',revision:fixture.file.revision,line:1,column:8})]})
      window.mousse={platform:'linux',
        platformRequest:{request:async(method,params)=>{fixture.calls.push({method,params:clone(params)});
          if(method==='browser.access.status')return clone({allowed:false,pending:fixture.browserPending})
          if(method==='browser.access.respond'){fixture.browserPending=fixture.browserPending.filter(item=>item.requestId!==params.requestId);return {allowed:params.allowed,pending:fixture.browserPending}}
          if(method==='chats.snapshot')return clone({agents,chats:Object.values(fixture.conversations),devices:[{id:'local',name:'Fixture laptop',isLocal:true,online:true}]})
          if(method==='chats.get')return clone(fixture.conversations[params.chatId])
          if(method==='chats.create'){const selected=params.agentIds.map(id=>agents.find(agent=>agent.id===id));const id='created-'+Object.keys(fixture.conversations).length;const chat={id,kind:params.kind,name:params.kind==='group'?params.name:selected[0].name,threadId:id+'-thread',...(params.projectId?{projectId:params.projectId}:{}),participants:[owner,...selected.map(participant)],createdAt:now,updatedAt:now,messages:[]};fixture.conversations[id]=chat;return clone(chat)}
          if(method==='chats.send'){const chat=fixture.conversations[params.chatId];chat.messages.push({id:params.clientMessageId,participantId:'owner',text:params.text,createdAt:now,status:'completed'});chat.run={id:'run-one',state:'running',startedAt:now,agentId:'agent-0'};return clone(chat)}
          if(method==='chats.cancel'){const chat=fixture.conversations[params.chatId];chat.run.state='cancelled';return clone(chat)}
          if(method==='chatResources.snapshot')return clone(resources(params.groupId))
          if(method==='browser.artifacts.read'){const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const context=canvas.getContext('2d');context.fillStyle='#16141c';context.fillRect(0,0,800,600);context.fillStyle='#2d2738';context.fillRect(0,0,800,60);context.fillStyle='#eee6f5';context.font='24px sans-serif';context.fillText('Billing preview',30,40);context.font='30px sans-serif';context.fillText('Choose your plan',40,150);context.font='18px sans-serif';context.fillStyle='#b4a8bf';context.fillText('Review subscription details before checkout.',40,190);context.strokeStyle='#51455e';context.strokeRect(40,235,330,230);context.fillStyle='#eee6f5';context.fillText('Team plan',65,275);context.font='32px sans-serif';context.fillText('$29 / month',65,330);context.fillStyle='#ad8ccd';context.fillRect(65,370,280,55);context.fillStyle='#211828';context.font='18px sans-serif';context.fillText('Continue to checkout',100,405);const png=canvas.toDataURL('image/png').split(',')[1];return {mediaType:'image/png',byteLength:atob(png).length,bytesBase64:png}}
          if(method==='chatResources.terminal.output')return {sequence:1,gap:false,chunks:params.afterSequence?[]:[{sequence:1,data:'$ npm run check\\r\\nBilling checks passed\\r\\n'}]}
          if(method==='chatResources.file.read')return clone(fixture.file)
          if(method==='chatResources.file.write'){if(fixture.file.revision!==params.expectedRevision)return clone({status:'conflict',file:fixture.file});fixture.file={path:params.path,content:params.content,revision:'saved'};return clone({status:'saved',file:fixture.file})}
          return {}
        }},
        window:{closeAgentsTasks:async()=>{},openAgentsTasks:async()=>{},isMaximized:async()=>false,onMaximizedChange:subscription},
        profiles:{list:async()=>({profiles:[{id:'default',displayName:'Default',isDefault:true,status:'active',revision:1}],defaultProfileId:'default'}),status:async()=>({binding:{profileId:'default'}})},
        app:{getInfo:async()=>({platform:'linux',deviceName:'Fixture laptop'}),getActiveProjectPath:async()=>'/fixture',onNavigateMainView:subscription},workspace:{getStatus:async()=>({})},
        orchestrator:{getMessages:async()=>[],answerQuestions:async(requestId,answers)=>{fixture.calls.push({method:'answerQuestions',params:{requestId,answers}});Object.values(fixture.conversations).forEach(chat=>{chat.pendingQuestions=[]})},dismissQuestions:async(requestId)=>{fixture.calls.push({method:'dismissQuestions',params:{requestId}});Object.values(fixture.conversations).forEach(chat=>{chat.pendingQuestions=[]})},onThreadMessage:subscription,onThreadMessageUpdated:subscription,onThreadMessages:subscription},
        agents:{list:async()=>[],onUpdated:subscription,onActivated:subscription},tasks:{list:async()=>[],onUpdated:subscription},
        projects:{list:async()=>fixture.projects,onUpdated:subscription},threads:{listAll:async()=>fixture.threads,active:async()=>null,getActivity:async()=>({}),onUpdated:subscription,onSelected:subscription,onActivity:subscription,onView:subscription},
        turn:{getSnapshot:async()=>({}),onTurnState:subscription,onTurnSnapshot:subscription},channels:{onActivity:subscription},documents:{onOpened:subscription}}
      useAppStore.setState({mainAreaOpen:false,threadsSidebarOpen:true,threadsSidebarWidth:280,sidebarMode:'projects'})
      createRoot(document.getElementById('root')).render(<App />)
    ` },
    bundle:true, platform:'browser',format:'iife',write:false,outfile:join(directory,'fixture.js'),jsx:'automatic',
    loader:{'.svg':'dataurl','.webp':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},
    plugins:[{name:'external-editor-and-unrelated-panels',setup(builder){
      builder.onResolve({filter:/^@monaco-editor\/react$/},()=>({path:'editor',namespace:'fixture-monaco'}))
      builder.onLoad({filter:/.*/,namespace:'fixture-monaco'},()=>({resolveDir:new URL('..',import.meta.url).pathname,loader:'tsx',contents:`
        import {useEffect,useState,useRef} from 'react'
        export default function Editor({value,onChange,onMount}) {
          const [decorations,setDecorations]=useState([]);const valueRef=useRef(value);valueRef.current=value
          useEffect(()=>{let cursor;onMount({createDecorationsCollection:()=>({set:items=>{window.fixture.decorations=items;setDecorations(items)}}),onDidChangeCursorSelection:listener=>{cursor=listener;return {dispose(){}}},onDidDispose(){},getModel:()=>({getLineCount:()=>valueRef.current.split('\\n').length,getLineMaxColumn:line=>valueRef.current.split('\\n')[line-1].length+1})});window.fixture.editorCursor=()=>cursor?.({selection:{positionLineNumber:1,positionColumn:4,selectionStartLineNumber:1,selectionStartColumn:4}})},[])
          return <div><textarea aria-label="Fixture shared file editor" value={value} onChange={event=>onChange(event.target.value)}/>{decorations.map((item,index)=><span key={index} className="fixture-file-cursor">{item.options.after.content}</span>)}</div>
        }
      `}))
      builder.onResolve({filter:/\/components\/(OrchestratorChat|MainViewPanel|MainViewTabs|QuickActionsButton)$/},args=>({path:args.path.split('/').at(-1),namespace:'fixture-panel'}))
      builder.onLoad({filter:/.*/,namespace:'fixture-panel'},args=>({resolveDir:new URL('..',import.meta.url).pathname,loader:'tsx',contents:'export function '+args.path+'(){return <div />}'}))
    }}]
  })
  for(const file of bundle.outputFiles)await writeFile(file.path,file.contents)
  const globalCss=await readFile(new URL('../src/renderer/styles/global.css',import.meta.url),'utf8').catch(()=>'')
  await writeFile(join(directory,'fixture.html'),`<html><head><link rel="stylesheet" href="fixture.css"><style>${globalCss}
    :root{--surface-base-rgb:12,12,14;--surface-strong-rgb:24,24,27;--surface-soft-rgb:24,24,27;--surface-elevated-rgb:30,30,33;--accent-rgb:170,140,200;--accent-pale-rgb:200,180,220;--accent:#b7a1d0;--text-primary:#f0f0f2;--text-secondary:#a4a1a8;--border:#303034;--bg-secondary:#18181b;--app-window-bg:#0c0c0e;--titlebar-height:48px;--gradient-surface:#121214}
    body{margin:0;color:var(--text-primary);font:14px sans-serif}*{box-sizing:border-box;animation:none!important}button{border:0;background:none;color:inherit;cursor:pointer;font:inherit}.header{min-height:42px}.chat-shared-browser-viewport img{min-height:220px;object-fit:contain;background:#262329}.chat-monaco-editor textarea{width:100%;height:200px;background:#17151b;color:white;padding:12px;border:0;font:12px monospace}
    </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  await writeFile(join(directory,'check.cjs'),String.raw`
    const assert=require('node:assert/strict')
    const {writeFileSync}=require('node:fs')
    const {app,BrowserWindow}=require('electron')
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
    app.whenReady().then(async()=>{
      const window=new BrowserWindow({width:1280,height:850,show:false,webPreferences:{backgroundThrottling:false}})
      const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code)}catch(error){console.error('Renderer evaluation:',code);throw error}}
      const exists=selector=>evaluate('!!document.querySelector('+JSON.stringify(selector)+')')
      const click=async selector=>{assert(await exists(selector),selector);await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await pause(80)}
      const setValue=async(selector,value)=>{await evaluate('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event(input instanceof HTMLSelectElement?"change":"input",{bubbles:true}));})()');await pause(60)}
      const rect=selector=>evaluate('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}})()')
      try{
        await window.loadFile(__dirname+'/fixture.html');await pause(350)
        await evaluate('fixture.store.setState({projects:fixture.projects,threads:fixture.threads})');await pause(80)
        assert((await rect('.threads-sidebar-toolbar')).top>=(await rect('.threads-sidebar-tabs')).bottom)
        assert((await rect('.threads-sidebar-toolbar button:first-child')).left<(await rect('.threads-sidebar-toolbar button:last-child')).left)
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".threads-sidebar-toolbar")).justifyContent'),'space-between')
        assert.equal(await evaluate('document.querySelector(".threads-sidebar-recent-heading").textContent'),'RECENTS')
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".threads-sidebar-recent")).borderTopWidth'),'1px')
        await click('.threads-sidebar-tabs button:last-child');await pause(150)
        assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".chats-sidebar-content h2")).map(e=>e.textContent)'),['ROSTER','GROUPS','RECENTS'])
        const checkEmpty=async()=>{
          const empty=await rect('.chat-workspace-empty'),icon=await rect('.chat-workspace-empty-icon'),title=await rect('.chat-workspace-empty h1'),description=await rect('.chat-workspace-empty > p'),button=await rect('.chat-workspace-empty > button')
          for(const child of [icon,title,description,button])assert(Math.abs((child.left+child.right)/2-(empty.left+empty.right)/2)<1,'Empty Chats content is centered')
          assert(title.top-icon.bottom>=19,'Icon and title have space')
          assert(button.top-description.bottom>=21,'Description and action have space')
          assert(icon.top>=empty.top && button.bottom<=empty.bottom,'Empty content fits its container')
          assert.equal(await evaluate('document.querySelector(".chat-workspace").scrollWidth<=document.querySelector(".chat-workspace").clientWidth'),true)
        }
        await checkEmpty()
        await click('.chat-workspace-empty > button')
        assert.equal(await evaluate('document.querySelector(".chat-kind-switch button:first-child").getAttribute("aria-pressed")'),'true')
        assert.equal(await exists('.chat-dialog select'),false,'DMs have no project picker')
        await click('[aria-label="Close new chat"]')
        assert.equal(await evaluate('document.querySelectorAll(".chat-roster button").length'),3)
        await click('[aria-label="Message Scout"]')
        assert.equal(await evaluate('fixture.chats.getState().activeChatId'),'scout-dm')
        assert.equal(await exists('.chat-resources'),false)
        await click('[aria-label="Message Pixel"]')
        assert.equal(await evaluate('fixture.calls.filter(call=>call.method==="chats.create").at(-1).params.agentIds[0]'),'agent-2')
        await click('.threads-sidebar-toolbar [aria-label="Search threads"]')
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Search chats')
        await setValue('[aria-label="Search chats"]','billing')
        assert.equal(await evaluate('document.querySelectorAll(".chat-list-row").length'),1)
        await click('[aria-label="Close chat search"]')
        await click('.threads-sidebar-toolbar [aria-label="New chat"]')
        assert.equal(await evaluate('document.querySelector(".chat-kind-switch button:first-child").getAttribute("aria-pressed")'),'true')
        assert.equal(await exists('.chat-dialog select'),false)
        await click('.chat-kind-switch button:last-child')
        assert.equal(await evaluate('document.querySelector(".chat-kind-switch button:last-child").textContent'),'Group')
        await setValue('.chat-dialog select','smile')
        await click('.chat-agent-choice:first-of-type input')
        await click('.chat-kind-switch button:first-child')
        assert.equal(await exists('.chat-dialog select'),false,'Switching back to a DM hides the project picker')
        await click('.chat-dialog button[type=submit]')
        assert.deepEqual(await evaluate('fixture.calls.filter(call=>call.method==="chats.create").at(-1).params'),{kind:'direct',agentIds:['agent-0']},'A group project selection cannot leak into a DM')
        assert.equal(await exists('.chat-project-chip'),false)
        await click('[aria-label="New group"]')
        assert.equal(await evaluate('document.querySelector(".chat-kind-switch button:last-child").getAttribute("aria-pressed")'),'true')
        assert.equal(await evaluate('document.querySelector(".chat-dialog button[type=submit]").disabled'),true)
        await setValue('.chat-dialog input[placeholder="billing-launch"]','design-crit')
        await click('.chat-agent-choice:first-of-type input')
        assert.equal(await evaluate('document.querySelector(".chat-dialog button[type=submit]").disabled'),true)
        await click('.chat-agent-choice:nth-of-type(2) input')
        await setValue('.chat-dialog select','smile')
        assert.equal(await evaluate('document.querySelector(".chat-dialog button[type=submit]").disabled'),false)
        await click('.chat-dialog button[type=submit]')
        assert.deepEqual(await evaluate('fixture.calls.filter(call=>call.method==="chats.create").at(-1).params'),{kind:'group',agentIds:['agent-0','agent-1'],name:'design-crit',projectId:'smile'})
        assert.equal(await exists('.chat-project-chip'),true)
        console.log('Chats creation passed: centered empty state, DM default, group-only project selection and Group labels.')
        const created=await evaluate('fixture.chats.getState().activeChatId')
        assert.equal(await evaluate('fixture.calls.filter(call=>call.method==="chatResources.snapshot").at(-1).params.groupId'),created)
        await click('.chat-mention-menu summary')
        await click('.chat-mention-menu button:first-child')
        assert.equal(await evaluate('document.querySelector(".agent-chat-composer textarea").value'),'@scout ')
        await setValue('[aria-label="Message agents"]','@scout review the billing flow')
        await click('[aria-label="Send message"]')
        assert.equal(await evaluate('fixture.calls.filter(call=>call.method==="chats.send").at(-1).params.text'),'@scout review the billing flow')
        assert.equal(await evaluate('document.querySelector(".agent-chat-composer textarea").value'),'')
        assert.equal(await exists('[aria-label="Stop agent run"]'),true)
        await click('[aria-label="Stop agent run"]')
        assert.equal(await evaluate('fixture.calls.filter(call=>call.method==="chats.cancel").at(-1).params.runId'),'run-one')
        await evaluate('fixture.conversations['+JSON.stringify(created)+'].messages.push({id:"persistent-agent-reply",participantId:"agent-0",text:"The daemon persisted this reply.",createdAt:"2026-10-01T12:01:00Z",status:"completed"});fixture.chats.getState().refresh()')
        await pause(100)
        assert.equal(await evaluate('document.querySelector(".chat-transcript").textContent.includes("The daemon persisted this reply.")'),true)
        assert.equal(await evaluate('document.querySelectorAll(".chat-shared-browser-viewport .chat-shared-cursor").length'),1)
        assert.equal(await evaluate('document.querySelector(".chat-shared-browser .chat-resource-url input").value'),'https://billing.example.test/preview')
        const cursorStyle=await evaluate('(()=>{const element=document.querySelector(".chat-shared-browser-viewport .chat-shared-cursor");return {left:parseFloat(element.style.left),top:parseFloat(element.style.top)}})()')
        assert.equal(cursorStyle.left,5,'Cropped high-DPI cursor offset')
        assert(Math.abs(cursorStyle.top-100/6)<0.001,'Cropped high-DPI cursor vertical offset')
        await evaluate('(()=>{const image=document.querySelector(".chat-shared-browser-viewport img");const r=image.getBoundingClientRect();image.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));})()');await pause(50)
        const mapped=await evaluate('fixture.calls.filter(call=>call.method==="chatResources.presence.update").at(-1).params.cursor')
        assert(Math.abs(mapped.x-300)<2 && Math.abs(mapped.y-200)<2,'Image point maps through crop origin and scale')
        await click('.chat-resource-tabs button:nth-child(2)');await pause(200)
        assert.equal(await evaluate('document.querySelector(".chat-terminal-viewport").textContent.includes("Second viewer")'),true)
        assert.equal(await exists('.chat-terminal-xterm .xterm'),true)
        await click('.chat-resource-tabs button:nth-child(3)')
        await click('.chat-resource-file-list button')
        await pause(100)
        assert.equal(await evaluate('fixture.decorations[0]?.options.after.content.trim()'),'Second viewer')
        await setValue('[aria-label="Fixture shared file editor"]','export const ready = true\n')
        assert.equal(await evaluate('(async()=>await fixture.confirmNavigation())()'),false)
        assert.equal(await evaluate('fixture.confirmed'),1)
        await click('.threads-sidebar-tabs button:first-child')
        assert.equal(await evaluate('fixture.store.getState().sidebarMode'),'chats','Dirty shared file must guard mode switch')
        await click('.chat-resource-tabs button:first-child')
        await click('.chat-resource-tabs button:nth-child(3)')
        assert.equal(await evaluate('document.querySelector(".chat-monaco-editor textarea").value'),'export const ready = true\n','Switching resource tabs preserves file draft')
        await evaluate('fixture.file='+JSON.stringify({path:'src/billing.ts',content:'export const ready = remote\n',revision:'r2'}))
        await click('.chat-shared-files .chat-resource-actions button')
        assert.equal(await evaluate('document.querySelector(".chat-file-conflict").textContent.includes("Your edits are preserved")'),true)
        assert.equal(await evaluate('document.querySelector(".chat-monaco-editor textarea").value'),'export const ready = true\n')
        await click('.chat-file-conflict button:last-child')
        assert.equal(await evaluate('document.querySelector(".chat-monaco-editor textarea").value'),'export const ready = true\n')
        await click('.chat-shared-files .chat-resource-actions button')
        assert.equal(await evaluate('fixture.calls.filter(call=>call.method==="chatResources.file.write").at(-1).params.expectedRevision'),'r2')
        assert.equal(await exists('.chat-file-conflict'),false)
        assert.equal(await evaluate('fixture.file.content'),'export const ready = true\n')
        const scoped=await evaluate('fixture.calls.filter(call=>call.method.startsWith("chatResources.")&&call.method!=="chatResources.presence.leave").every(call=>call.params.groupId==='+JSON.stringify(created)+')')
        assert.equal(scoped,true,'Resources must all share the active group ID')
        const pending={requestId:'approval-one',threadId:created+'-thread',questions:[{id:'tool-approval',prompt:'Allow Forge to run npm run check in this group?',options:[{id:'allow',label:'Allow once'},{id:'deny',label:'Deny'}]}]}
        await evaluate('fixture.conversations['+JSON.stringify(created)+'].pendingQuestions='+JSON.stringify([pending])+'; fixture.chats.getState().openChat('+JSON.stringify(created)+')');await pause(120)
        assert.equal(await evaluate('document.querySelector(".composer-question-prompt").textContent'),pending.questions[0].prompt)
        await click('.composer-question-option:first-child')
        await click('.composer-question-submit')
        assert.deepEqual(await evaluate('fixture.calls.filter(call=>call.method==="answerQuestions").at(-1).params'),{requestId:'approval-one',answers:{'tool-approval':'allow'}})
        assert.equal(await exists('.composer-question-modal'),false)
        pending.requestId='approval-two'
        await evaluate('fixture.conversations['+JSON.stringify(created)+'].pendingQuestions='+JSON.stringify([pending])+'; fixture.chats.getState().refresh()');await pause(100)
        await click('[aria-label="Dismiss questions"]')
        assert.equal(await evaluate('fixture.calls.filter(call=>call.method==="dismissQuestions").at(-1).params.requestId'),'approval-two')
        assert.equal(await exists('.composer-question-modal'),false)
        const threadId=await evaluate('fixture.chats.getState().conversation.threadId')
        await evaluate('fixture.browserPending='+JSON.stringify([{requestId:'other-browser',threadId:'unrelated-thread'}])+'; fixture.chats.getState().openChat('+JSON.stringify(created)+')');await pause(120)
        assert.equal(await exists('[aria-label="Agent browser access request"]'),false,'Other chats browser requests must stay scoped')
        await evaluate('fixture.browserPending.push('+JSON.stringify({requestId:'browser-allow',threadId})+');fixture.chats.getState().openChat('+JSON.stringify(created)+')');await pause(120)
        assert.equal(await exists('[aria-label="Agent browser access request"]'),true,'Browser approval hydrates on chat reload')
        await click('.chat-browser-permission button:first-of-type')
        assert.deepEqual(await evaluate('fixture.calls.filter(call=>call.method==="browser.access.respond").at(-1).params'),{requestId:'browser-allow',allowed:true})
        assert.equal(await exists('[aria-label="Agent browser access request"]'),false)
        await evaluate('fixture.browserPending.push('+JSON.stringify({requestId:'browser-deny',threadId})+');fixture.chats.getState().openChat('+JSON.stringify(created)+')');await pause(120)
        await click('.chat-browser-permission button:last-child')
        assert.deepEqual(await evaluate('fixture.calls.filter(call=>call.method==="browser.access.respond").at(-1).params'),{requestId:'browser-deny',allowed:false})
        assert.equal(await exists('[aria-label="Agent browser access request"]'),false)
        await click('.chat-resource-tabs button:first-child');await pause(100)
        console.log('Chats shared tools and approvals passed; capturing the rendered workspace.')
        writeFileSync('/tmp/mousse-agent-chats.png',(await window.webContents.capturePage()).toPNG())
        await evaluate('fixture.store.setState({threadsSidebarWidth:180})')
        window.setSize(800,850);await pause(150)
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-workspace")).flexDirection'),'column')
        assert.equal(await evaluate('Array.from(document.querySelectorAll(".threads-sidebar-tab")).every(button=>button.scrollWidth<=button.clientWidth)'),true)
        assert((await rect('.chat-resources')).right<=800)
        // Saved group files permit ordinary rail tools to return to Projects mode.
        for(const [view,menuIndex] of [['terminal',3],['files',2]]) {
          await click('.navigation-rail [aria-label="More"]')
          await click('.navigation-rail-menu button:nth-child('+menuIndex+')')
          assert.deepEqual(await evaluate('({mode:fixture.store.getState().sidebarMode,view:fixture.store.getState().mainView,open:fixture.store.getState().mainAreaOpen})'),{mode:'projects',view,open:true})
          assert.equal(await exists('.chat-workspace'),false,'Rail tool replaces Chats workspace')
          assert.equal(await evaluate('getComputedStyle(document.querySelector(".main-area")).display!=="none"'),true)
          assert((await rect('.main-area')).width>0,'Existing Projects tools are visible')
          await click('.threads-sidebar-tabs button:last-child')
          assert.equal(await exists('.chat-workspace'),true,'Chats remains available after rail tool navigation')
        }
        await evaluate('fixture.chats.setState({activeChatId:null,conversation:null,loading:false})');await pause(80);await checkEmpty()
        assert.deepEqual(await evaluate('fixture.errors'),[])
        console.log('Agent chats passed: real App mode/toolbar, Projects RECENTS separator, roster/DM/group creation and project, search/mentions/send/cancel, daemon refresh, group-scoped shared resources, browser/terminal/file cursor overlays, file conflict preservation/navigation guard/tab retention, persisted approval answer/dismiss, scoped browser grants and URL/cropped high-DPI cursor mapping, narrow layout, Chats-to-Projects rail Terminal/Files navigation.')
        window.destroy();app.quit()
      }catch(error){console.error(error);app.exit(1)}
    })
  `)
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(electron,[join(directory,'check.cjs')],{env,stdio:'inherit'})
    const timer=setTimeout(()=>{child.kill();reject(new Error('Agent chats check timed out'))},30_000)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',code=>{clearTimeout(timer);resolve(code)})
  })
  assert.equal(code,0,'Agent chats Chromium check failed')
}finally{await rm(directory,{recursive:true,force:true})}
