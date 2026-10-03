import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

const entry = resolve('out/net-qa/native-reader-daemon.js'), cliEntry = resolve('out/cli/index.js')
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
async function wait<T>(get: () => T|undefined, label: string, timeout = 40000): Promise<T> {
  const end = Date.now()+timeout
  for (;;) { const value = get(); if (value !== undefined) return value; if (Date.now()>=end) throw Error(`Actual daemon ${label} timed out`); await sleep(50) }
}
function read(home: string): any { try { return JSON.parse(readFileSync(join(home,'reader-qa-report.json'),'utf8')) } catch { return undefined } }
async function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
  if (child.exitCode!==null || child.signalCode!==null) return
  const ended = new Promise<void>(resolve => child.once('exit',()=>resolve()))
  child.kill(signal); await ended
}
function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'reader-three-daemons-'))), project=join(root,'project'), sensitive=join(root,'sensitive'), children:ChildProcess[]=[]
  mkdirSync(project); mkdirSync(sensitive); writeFileSync(join(project,'allowed.txt'),'SAFE_READER_MARKER\n'); writeFileSync(join(sensitive,'secret.txt'),'QA_PRIVATE_DENIED_MARKER\n')
  const start=async(role:'host'|'executor'|'sender')=>{
    const home=join(root,role);mkdirSync(home,{recursive:true});let logs=''
    const child=spawn(process.execPath,[entry,home,project,role],{stdio:['ignore','pipe','pipe'],env:{...process.env,MOUSSE_HOME:home,MOUSSE_REPO_ROOT:project,NO_COLOR:'1'}});children.push(child)
    child.stdout!.on('data',bytes=>{logs=(logs+bytes).slice(-16000)});child.stderr!.on('data',bytes=>{logs=(logs+bytes).slice(-16000)})
    await wait(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(`Actual ${role} owner exited: ${logs}`);const report=read(home);return report?.pid===child.pid?report:undefined},role+' owner readiness')
    return {role,home,child,report:()=>read(home),logs:()=>logs}
  }
  const cli=(home:string,args:string[],input?:string)=>new Promise<{code:number|null;value:any;output:string;error:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[cliEntry,'--home',home,'--json',...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,MOUSSE_HOME:home,MOUSSE_REPO_ROOT:project,NO_COLOR:'1'}});children.push(child)
    let output='',error='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Actual reader owner CLI timed out'))},30000)
    child.stdout!.on('data',bytes=>{output+=bytes});child.stderr!.on('data',bytes=>{error+=bytes});child.once('error',reason=>{clearTimeout(timer);reject(reason)});child.once('exit',code=>{clearTimeout(timer);let value;try{value=JSON.parse(code===0?output:error)}catch{}resolve({code,value,output,error})});child.stdin!.end(input)
  })
  return {root,project,sensitive,start,cli,async close(){await Promise.all(children.map(child=>kill(child)));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}}
}

it.skipIf(!['darwin','linux'].includes(process.platform))('loads the exact hashed packaged reader only through trusted owner code, preserving protected keys and ordinary local IPC across restart',async()=>{
  const qa=harness()
  try {
    const owner=await qa.start('executor'), inactive=await qa.start('host')
    expect(owner.report()).toMatchObject({readerSupported:true,paidProviderQualified:false,callCount:0,artifact:{napi:8,packaged:true}})
    expect(inactive.report()).toMatchObject({readerSupported:false,callCount:0})
    expect((await qa.cli(owner.home,['net','init','--listen'])).code).toBe(0)
    expect((await qa.cli(owner.home,['net','protect'],'fixed-reader-owned-protection')).code).toBe(0)
    const original=await wait(()=>owner.report()?.protected?owner.report():undefined,'protected reader keys')
    expect(original.self.user).toBeDefined()
    const stopped=await qa.cli(owner.home,['service','stop']);expect(stopped.code,stopped.error).toBe(0)
    await wait(()=>owner.child.exitCode!==null?true:undefined,'cooperative owner exit')
    const restarted=await qa.start('executor')
    expect(restarted.report().self).toMatchObject({user:original.self.user,node:original.self.node,isAuthority:false})
    expect((await qa.cli(restarted.home,['net','unlock'],'fixed-reader-owned-protection')).code).toBe(0)
    await wait(()=>restarted.report()?.self?.isAuthority===true?true:undefined,'unlocked authority proof')
    expect(restarted.report().self).toEqual(original.self)
    expect(restarted.report().paidProviderQualified).toBe(false)
    expect(restarted.report().callCount).toBe(0)
    expect((await qa.cli(restarted.home,['bots','list'])).value).toEqual({bots:[]})
    expect([owner.logs(),restarted.logs()].join('\n')).not.toContain('fixed-reader-owned-protection')
  } finally { await qa.close() }
},90000)
