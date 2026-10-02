import { generateKeyPairSync, createSign, createHash, X509Certificate, randomBytes } from 'node:crypto'
import tls from 'node:tls'
import { Duplex } from 'node:stream'
// Minimal DER
const len=n=>n<0x80?Buffer.from([n]):n<0x100?Buffer.from([0x81,n]):Buffer.from([0x82,n>>8,n&0xff])
const tlv=(t,...v)=>{const b=Buffer.concat(v);return Buffer.concat([Buffer.from([t]),len(b.length),b])}
const seq=(...v)=>tlv(0x30,...v), set=(...v)=>tlv(0x31,...v)
const oid=hex=>tlv(0x06,Buffer.from(hex,'hex'))
const int=b=>tlv(0x02,b[0]&0x80?Buffer.concat([Buffer.from([0]),b]):b)
const utf8=s=>tlv(0x0c,Buffer.from(s))
const time=d=>tlv(0x18,Buffer.from(d.toISOString().replace(/[-:T]/g,'').slice(0,14)+'Z'))
const ECDSA_SHA256=seq(oid('2a8648ce3d040302'))
function selfSigned(cn){ const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}); const spki=publicKey.export({type:'spki',format:'der'})
  const name=seq(set(seq(oid('550403'),utf8(cn))))
  const serial=randomBytes(16); serial[0]&=0x7f; serial[0]|=0x01
  const tbs=seq(tlv(0xa0,int(Buffer.from([2]))),int(serial),ECDSA_SHA256,name,seq(time(new Date(Date.now()-864e5)),time(new Date(Date.now()+3650*864e5))),name,spki)
  const sig=createSign('sha256').update(tbs).sign(privateKey)
  const der=seq(tbs,ECDSA_SHA256,tlv(0x03,Buffer.from([0]),sig))
  return {cert:`-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`, key:privateKey.export({type:'pkcs8',format:'pem'})} }
const a=selfSigned('nod_a'), b=selfSigned('nod_b')
const xa=new X509Certificate(a.cert); console.log('parsed', xa.subject, xa.validTo, 'selfverify', xa.verify(xa.publicKey))
const fp=c=>createHash('sha256').update(new X509Certificate(c).publicKey.export({type:'spki',format:'der'})).digest('hex').slice(0,16)
let x,y; x=new Duplex({read(){},write(c,e,cb){y.push(c);cb()}}); y=new Duplex({read(){},write(c,e,cb){x.push(c);cb()}})
const srv=new tls.TLSSocket(y,{isServer:true,requestCert:true,rejectUnauthorized:false,minVersion:'TLSv1.3',key:b.key,cert:b.cert})
const cli=tls.connect({socket:x,minVersion:'TLSv1.3',rejectUnauthorized:false,key:a.key,cert:a.cert})
srv.on('secure',()=>console.log('srv pinned ok', fp(srv.getPeerCertificate(true).raw)===fp(a.cert)))
cli.on('secureConnect',()=>{console.log('cli pinned ok', fp(cli.getPeerCertificate(true).raw)===fp(b.cert), cli.getProtocol()); setTimeout(()=>process.exit(0),50)})
for (const s of [srv,cli]) s.on('error',e=>{console.log('ERR',e.message);process.exit(1)})
setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},5000)
