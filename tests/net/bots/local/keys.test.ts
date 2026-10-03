import { mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect,it } from 'vitest'
import { FileKeyStore } from '../../../../src/mms/net/identity/FileKeyStore'
import { newId } from '../../../../src/shared/net'
import { verifyBytes } from '../../../../src/mms/net/identity/crypto'

it('returns the actual protected bot key after reopening and denies locked, stale, foreign and replaced key files',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bot-key-ensure-'))),dir=join(root,'profile'),other=join(root,'other'),codec={canEncrypt:()=>false,encrypt:()=>null,decrypt:()=>null}
  try{
    mkdirSync(dir);mkdirSync(other)
    const keys=new FileKeyStore(dir,{codec,passphrase:'task-owned-key-test'});await keys.initialize({asAuthority:true})
    const bot=newId('bot'),key=keys.ensureBotKey(bot),bytes=Buffer.from('Exact actual signer')
    expect(keys.ensureBotKey(bot)).toBe(key)
    const reopened=new FileKeyStore(dir,{codec});expect(()=>reopened.ensureBotKey(bot)).toThrow(expect.objectContaining({code:'keystore_locked'}))
    await reopened.unlock('task-owned-key-test');expect(reopened.ensureBotKey(bot)).toBe(key);verifyBytes(bytes,reopened.signAsBot(bot,bytes),key)
    const foreign=new FileKeyStore(other,{codec,passphrase:'task-owned-key-test'});await foreign.initialize({asAuthority:true})
    expect(foreign.ensureBotKey(bot)).not.toBe(key);expect(()=>verifyBytes(bytes,foreign.signAsBot(bot,bytes),key)).toThrow(expect.objectContaining({code:'bad_signature'}))
    reopened.putSecret('new-checkpoint',Buffer.from('actual-changed-file'))
    expect(()=>keys.ensureBotKey(bot)).toThrow(expect.objectContaining({code:'conflict'}))
    expect(()=>keys.ensureBotKey(newId('bot'))).toThrow(expect.objectContaining({code:'conflict'}))
    const target=join(other,'net','keys.json'),file=join(dir,'net','keys.json');unlinkSync(file);symlinkSync(target,file)
    expect(()=>reopened.ensureBotKey(bot)).toThrow(expect.objectContaining({code:'forbidden'}))
  }finally{rmSync(root,{recursive:true,force:true})}
})
