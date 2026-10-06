import { randomBytes } from 'node:crypto'

export interface AppletSource {
  html: string
  css: string
  js: string
  data?: unknown
}

export const APPLET_EVENT_PREFIX = '__MOUSSE_APPLET_EVENT__'

/** The document has no privileged preload. Its public bridge only reports untrusted data. */
export function appletDocument(source: AppletSource, state?: unknown): string {
  const nonce = randomBytes(24).toString('base64')
  const json = (value: unknown) => JSON.stringify(value ?? null).replace(/</g, '\\u003c')
  const script = source.js.replace(/<\/script/gi, '<\\/script')
  const css = source.css.replace(/<\/style/gi, '<\\/style')
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;font:14px system-ui;color:#e8e8ed;background:transparent}*{box-sizing:border-box}button,input,select{font:inherit}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style><style>${css}</style><script nonce="${nonce}">
(()=>{
 for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport'])Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false});
 for(const [key,value] of Object.entries({alert:()=>{},confirm:()=>false,prompt:()=>null,print:()=>{}}))Object.defineProperty(window,key,{value,writable:false,configurable:false});
 const log=console.log.bind(console);let count=0;setInterval(()=>count=0,1000);
 Object.defineProperty(window,'console',{value:Object.freeze(Object.fromEntries(Object.getOwnPropertyNames(console).map(key=>[key,()=>{}]))),writable:false,configurable:false});
 const send=(type,payload)=>{if(++count>30)return;try{const message=JSON.stringify({type,payload});if(message.length<=65536)log(${json(APPLET_EVENT_PREFIX)}+message)}catch{}};
 send('heartbeat',null);setInterval(()=>send('heartbeat',null),500);
 Object.defineProperty(window,'mousseApplet',{value:Object.freeze({data:${json(source.data)},state:${json(state)},saveState:value=>send('state',value),resize:height=>send('resize',height),reportError:message=>send('error',String(message).slice(0,2000)),requestConversationInput:text=>send('conversation-input',String(text).slice(0,4000))}),writable:false,configurable:false});
 addEventListener('error',event=>{event.preventDefault();send('error',String(event.message).slice(0,2000))});
 addEventListener('unhandledrejection',event=>{event.preventDefault();send('error','An applet promise failed.')});
 addEventListener('DOMContentLoaded',()=>{send('ready',null);let timer;new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>send('resize',Math.ceil(document.documentElement.scrollHeight)),100)}).observe(document.body)});
})();</script></head><body>${source.html}<script nonce="${nonce}">${script}</script></body></html>`
}
