#!/usr/bin/env node
// Restore missing/version-mismatched lockfile packages in an OWNED dependency copy.
// Never run against the shared Linux cache. Integrity is checked before extraction.
import {readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import{createHash}from'node:crypto'
import{tmpdir}from'node:os'
import{join,resolve,relative}from'node:path'
import{execFileSync}from'node:child_process'
if(process.platform!=='linux'||process.env.MOUSSE_OWNED_LINUX_DEPENDENCIES!=='yes')throw Error('Explicit owned Linux dependency copy required')
const lock=JSON.parse(readFileSync('package-lock.json')),temp=mkdtempSync(join(tmpdir(),'mousse-lock-download-')),updated=[]
try{for(const [path,want]of Object.entries(lock.packages)){
 if(!path||want.optional||!want.resolved?.startsWith('https://registry.npmjs.org/')||!want.integrity)continue
 let version;try{version=JSON.parse(readFileSync(join(path,'package.json'))).version}catch{}
 if(version===want.version)continue
 const target=resolve(path);if(relative(resolve('node_modules'),target).startsWith('..'))throw Error('Lock path outside owned dependency tree')
 const response=await fetch(want.resolved);if(!response.ok)throw Error('Package download failed: '+path)
 const bytes=Buffer.from(await response.arrayBuffer()),[algorithm,hash]=want.integrity.split('-');if(algorithm!=='sha512'||createHash(algorithm).update(bytes).digest('base64')!==hash)throw Error('Package integrity mismatch')
 const file=join(temp,'dependency.tgz');writeFileSync(file,bytes);mkdirSync(target,{recursive:true});execFileSync('tar',['-xzf',file,'--strip-components=1','-C',target]);updated.push({path,version:want.version,integrity:want.integrity})
 }
 console.log(JSON.stringify({updated},null,2))
}finally{rmSync(temp,{recursive:true,force:true})}
