import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fstatSync,readFileSync,realpathSync,statSync} from 'node:fs'
import {isAbsolute,relative,sep} from 'node:path'
import {NetError} from '../../../shared/net'
export interface NativeReaderModule {
  openRoot(root:string):number
  closeRoot(fd:number):void
  read(fd:number,path:string,maximumBytes:number,barrier?:(component:number)=>void):Buffer
  list(fd:number,path:string,maximumEntries:number,barrier?:(component:number)=>void):Array<{name:string;kind:'file'|'directory'|'blocked'}>
}
export interface NativeReaderQualification {platform:'darwin'|'linux';napi:number;artifactSha256:string;packaged:boolean}
const loaded=new WeakMap<NativeReaderModule,NativeReaderQualification>()
export function nativeReaderQualified(module:NativeReaderModule,qualification:NativeReaderQualification):boolean{const q=loaded.get(module);return Boolean(q?.packaged&&qualification.packaged&&q.artifactSha256===qualification.artifactSha256&&q.platform===process.platform&&q.napi===qualification.napi&&Number(process.versions.napi)>=q.napi)}
export function loadNativeReader(path:string,qualification:NativeReaderQualification):NativeReaderModule {
  if(process.platform!==qualification.platform||Number(process.versions.napi)<qualification.napi||qualification.napi<8||!/^[0-9a-f]{64}$/.test(qualification.artifactSha256)||createHash('sha256').update(readFileSync(path)).digest('hex')!==qualification.artifactSha256)throw new NetError('profile_unsupported')
  const module=createRequire(import.meta.url)(realpathSync.native(path)) as NativeReaderModule
  if(['openRoot','closeRoot','read','list'].some(name=>typeof (module as unknown as Record<string,unknown>)[name]!=='function'))throw new NetError('profile_unsupported')
  loaded.set(module,structuredClone(qualification));return module
}
function inside(root:string,path:string):boolean{const r=relative(root,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${sep}`))}
function bounded(value:number,max:number):number{if(!Number.isSafeInteger(value)||value<1||value>max)throw new NetError('bad_request');return value}
/** Uses pinned openat handles; never follows links or calls the ordinary Pi/shell tools. */
export class NativeReader {
  readonly root:string
  private readonly fd:number
  private readonly identity:{dev:number;ino:number}
  private closed=false
  constructor(private readonly native:NativeReaderModule,root:string,deniedRoots:readonly string[],private readonly signal?:AbortSignal){
    this.root=realpathSync.native(root)
    if(!deniedRoots.length||deniedRoots.some(path=>{const denied=realpathSync.native(path);return inside(this.root,denied)||inside(denied,this.root)}))throw new NetError('forbidden')
    this.fd=native.openRoot(this.root);const stat=fstatSync(this.fd);if(!stat.isDirectory()){native.closeRoot(this.fd);throw new NetError('forbidden')}this.identity={dev:stat.dev,ino:stat.ino}
  }
  read(path:string,maximumBytes=262144):string{this.active();this.path(path,false);try{const data=this.native.read(this.fd,path,bounded(maximumBytes,262144));this.active();return new TextDecoder('utf-8',{fatal:true}).decode(data)}catch(error){this.translate(error)}}
  list(path='',maximumEntries=1024):Array<{name:string;kind:'file'|'directory'|'blocked'}>{this.active();this.path(path,true);try{const rows=this.native.list(this.fd,path,bounded(maximumEntries,4096));this.active();return rows.sort((a,b)=>a.name.localeCompare(b.name))}catch(error){this.translate(error)}}
  search(query:string,{path='',maxResults=100,maxFiles=1000,maxDepth=16,maxElapsedMs=2000}:{path?:string;maxResults?:number;maxFiles?:number;maxDepth?:number;maxElapsedMs?:number}={}):Array<{path:string;line:number;text:string}>{
    if(typeof query!=='string'||!query||Buffer.byteLength(query)>4096)throw new NetError('bad_request');this.path(path,true);bounded(maxResults,200);bounded(maxFiles,2000);bounded(maxDepth,32);bounded(maxElapsedMs,5000)
    const deadline=performance.now()+maxElapsedMs,results:Array<{path:string;line:number;text:string}>=[];let files=0,bytes=0
    const visit=(directory:string,depth:number):void=>{this.active();if(performance.now()>deadline)throw new NetError('deadline_exceeded');if(depth>maxDepth)throw new NetError('too_large');for(const row of this.list(directory,1024)){if(performance.now()>deadline)throw new NetError('deadline_exceeded');const child=directory?`${directory}/${row.name}`:row.name;if(row.kind==='directory')visit(child,depth+1);else if(row.kind==='file'){if(++files>maxFiles)throw new NetError('too_large');let text:string;try{text=this.read(child)}catch(error){if(error instanceof NetError&&['too_large','bad_request'].includes(error.code))continue;throw error}bytes+=Buffer.byteLength(text);if(bytes>8*1024*1024)throw new NetError('too_large');const lines=text.split('\n');for(let index=0;index<lines.length;index++){if(lines[index].includes(query)){if(results.length>=maxResults)throw new NetError('too_large');results.push({path:child,line:index+1,text:lines[index].slice(0,2048)})}}}}}
    visit(path,0);return results
  }
  checkPath(path:string,directory:boolean):void{this.active();this.path(path,directory)}
  close():void{if(this.closed)return;this.closed=true;this.native.closeRoot(this.fd)}
  private path(path:string,directory:boolean):void{if(typeof path!=='string'||Buffer.byteLength(path)>4096||(!directory&&!path)||path.includes('\0')||path.includes('\\')||path.includes(':')||isAbsolute(path)||path.split('/').some(part=>part==='.'||part==='..'||(!part&&path!=='')))throw new NetError('forbidden')}
  private active():void{if(this.signal?.aborted)throw new NetError('cancelled');if(this.closed)throw new NetError('forbidden');let stat;try{if(realpathSync.native(this.root)!==this.root)throw new NetError('forbidden');stat=statSync(this.root)}catch{throw new NetError('forbidden')}if(!stat.isDirectory()||stat.dev!==this.identity.dev||stat.ino!==this.identity.ino)throw new NetError('forbidden')}
  private translate(error:unknown):never{if(error instanceof NetError)throw error;const code=(error as {code?:string})?.code;if(code==='too_large')throw new NetError('too_large');if(error instanceof TypeError)throw new NetError('bad_request');throw new NetError('forbidden')}
}
