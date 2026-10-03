import { expect,it } from 'vitest'
import { parseArgs, type ParsedArgs } from '../../../src/cli/parseArgs'
import { prepareSpacesCommand,executeSpacesCommand } from '../../../src/cli/commands/spaces'
import { newId } from '../../../src/shared/net'
function args(subcommand:string,positional:string[]=[],flags:Record<string,string|boolean>={}):ParsedArgs{return {...parseArgs([]),command:'spaces',subcommand,positional,flags:new Map(Object.entries(flags)),raw:['spaces',subcommand,...positional]}}
it('prepares exact public space commands while rejecting execution overrides and oversized/extra authority',()=>{
  const space=newId('space'),stream=newId('stream')
  expect(prepareSpacesCommand(args('create',['Name'],{channel:'general'}))).toEqual({method:'spaces.create',params:{name:'Name',channelName:'general'}})
  expect(prepareSpacesCommand(args('invite',[space],{ttl:'1d',uses:'2',role:'member'}))).toMatchObject({method:'spaces.invite',params:{space,ttlMs:86400000,uses:2,role:'member'}})
  expect(prepareSpacesCommand(args('tail',[stream],{after:'1:5',limit:'12',follow:true}))).toMatchObject({method:'spaces.tail',params:{stream,after:{epoch:1,seq:5},limit:12},follow:true})
  expect(()=>prepareSpacesCommand(args('invite',[space],{ttl:'2d'}))).toThrow()
  for(const extra of ['provider','path','login','bot','refs','participants','id'])expect(()=>prepareSpacesCommand(args('post',[stream,'text'],{[extra]:'no'}))).toThrow()
  const unsafe=args('post',[stream,'text']);unsafe.globals.model='override';expect(()=>prepareSpacesCommand(unsafe)).toThrow()
  expect(()=>prepareSpacesCommand(args('post',[stream,'x'.repeat(60*1024+1)]))).toThrow()
})
it('reads an sj1 secret outside command flags and sends its exact local join DTO',async()=>{
  const calls:unknown[]=[],out:unknown[]=[],request=prepareSpacesCommand(args('join',[],{name:'Member'}))
  expect(request.promptInvite).toBe(true)
  await executeSpacesCommand(request,{request:async<T>(method:string,params:unknown)=>{calls.push({method,params});return {space:'joined'} as T}},{readInvite:async()=>'sj1_payload',emit:value=>out.push(value)})
  expect(calls).toEqual([{method:'spaces.join',params:{name:'Member',invite:'sj1_payload'}}]);expect(out).toEqual([{space:'joined'}])
})
it('follows bounded pages from the returned cursor and cancels its idle polling without resending old pages',async()=>{
  const stream=newId('stream'),abort=new AbortController(),calls:unknown[]=[],values:unknown[]=[],request=prepareSpacesCommand(args('tail',[stream],{follow:true,limit:'1'}))
  await executeSpacesCommand(request,{request:async<T>(_method:string,params:unknown)=>{calls.push(params);const seq=calls.length;return {stream,head:{epoch:1,seq:2},cursor:{epoch:1,seq},records:[{seq}],done:seq===2,readonly:false,offline:false} as T}},{signal:abort.signal,emit:value=>values.push(value),wait:async()=>{abort.abort()}})
  expect(calls).toEqual([{stream,limit:1},{stream,limit:1,after:{epoch:1,seq:1}}]);expect(values).toHaveLength(2)
})
