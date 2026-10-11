import {spawn} from 'node:child_process'
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {build} from 'esbuild'
import electron from 'electron'
import {expect,it} from 'vitest'

it('rediscoveries durable tasks and separates read/start/retrieve actions in the actual mounted React picker',async()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'task-picker-react-')))
  try{
    const main=join(directory,'main.cjs'),renderer=join(directory,'renderer.js'),html=join(directory,'index.html'),config=join(directory,'config.json'),evidence=join(directory,'evidence.json')
    await Promise.all([
      build({entryPoints:[resolve('tests/fixtures/net-gui/task-picker-electron.ts')],outfile:main,bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'}),
      build({entryPoints:[resolve('tests/fixtures/net-gui/task-picker.tsx')],outfile:renderer,bundle:true,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'})
    ])
    writeFileSync(html,'<!doctype html><div id="root"></div><script src="renderer.js"></script>')
    writeFileSync(config,JSON.stringify({html,evidence,userData:join(directory,'user-data')}))
    const env={...process.env,MOUSSE_TASK_PICKER_FIXTURE:config};delete env.ELECTRON_RUN_AS_NODE
    const exited=await new Promise<{code:number|null;stderr:string}>((done,reject)=>{
      const child=spawn(electron as unknown as string,[main],{env,stdio:['ignore','ignore','pipe']});let stderr=''
      const timer=setTimeout(()=>child.kill('SIGKILL'),20000)
      child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-4000)})
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('exit',code=>{clearTimeout(timer);done({code,stderr})})
    })
    const result=JSON.parse(readFileSync(evidence,'utf8'))
    expect(result.ok,JSON.stringify(result)+'\n'+exited.stderr).toBe(true);expect(exited.code).toBe(0)
    expect(result.initialCalls.map((call:any)=>call.method).sort()).toEqual(['bridge.nodes','chats.tasks'])
    const dispatch=result.durableCalls.filter((call:any)=>call.method==='chats.dispatch')
    expect(dispatch).toEqual([{method:'chats.dispatch',params:{chatId:'chat-fixture',taskId:'rpc_durable'}}])
    expect(result.durableCalls.some((call:any)=>call.method==='chats.assignDevice')).toBe(false)
    expect(result.durableCalls.filter((call:any)=>call.method==='chats.task.get'&&call.params.result)).toEqual([{method:'chats.task.get',params:{chatId:'chat-fixture',taskId:'rpc_durable',result:true}}])
    expect(result.pageCalls.find((call:any)=>call.method==='chats.tasks'&&call.params.after)?.params).toEqual({chatId:'chat-fixture',limit:32,after:'rpc_durable'})
    expect(result.prepareCalls).toHaveLength(3);expect(result.originalFrozen).toBe(true);expect(result.lateDiscarded).toBe(true)
    expect(result.allPreparations).toHaveLength(5)
    expect(result.secondOriginal.taskId).not.toBe(result.prepareCalls[0].params.taskId)
    expect(result.secondOriginal.input.prompt).toBe('SECOND EXPLICIT INTENT')
    expect(result.allPreparations[4].params).toEqual(result.allPreparations[3].params)
    expect(result.terminalReset).toBe(true);expect(result.rollbackCleared).toBe(true)
  }finally{rmSync(directory,{recursive:true,force:true})}
},25000)
