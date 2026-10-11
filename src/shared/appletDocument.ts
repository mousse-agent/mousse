import {
  APPLET_APPEARANCE_TOKENS,
  validateAppletAppearance,
  type AppletAppearance
} from './appletAppearance'
import { APPLET_HOST_STYLES, DEFAULT_APPLET_APPEARANCE } from './appletAppearanceStyles'
import { APPLET_ICON_GEOMETRY, APPLET_ICON_ALIASES } from './appletIcons'

export interface AppletSource {
  html: string
  css: string
  js: string
  data?: unknown
}

export const APPLET_APPLY_APPEARANCE = '__mousseApplyAppearance'
export const APPLET_EVENT_PREFIX = '__MOUSSE_APPLET_EVENT__'

/** The document has no privileged preload. Its public bridge only reports untrusted data. */
export function appletDocument(
  source: AppletSource,
  state?: unknown,
  appearance?: AppletAppearance,
  scrollPositions?: Array<{path:number[];top:number;left:number}>
): string {
  const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('')
  const initialAppearance = validateAppletAppearance(appearance ?? DEFAULT_APPLET_APPEARANCE)
  const json = (value: unknown) => JSON.stringify(value ?? null).replace(/</g, '\\u003c')
  const script = source.js.replace(/<\/script/gi, '<\\/script')
  const css = source.css.replace(/<\/style/gi, '<\\/style')
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@layer mousse-applet-scrollbars;</style><style>${css}</style><style id="mousse-applet-host-style">${APPLET_HOST_STYLES}</style><script nonce="${nonce}">
(()=>{
 for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport'])Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false});
 for(const [key,value] of Object.entries({alert:()=>{},confirm:()=>false,prompt:()=>null,print:()=>{}}))Object.defineProperty(window,key,{value,writable:false,configurable:false});
 const log=console.log.bind(console);let count=0;setInterval(()=>count=0,1000);
 Object.defineProperty(window,'console',{value:Object.freeze(Object.fromEntries(Object.getOwnPropertyNames(console).map(key=>[key,()=>{}]))),writable:false,configurable:false});
 const send=(type,payload)=>{if(++count>30)return;try{const message=JSON.stringify({type,payload});if(message.length<=65536)log(${json(APPLET_EVENT_PREFIX)}+message)}catch{}};
 send('heartbeat',null);setInterval(()=>send('heartbeat',null),500);
 const appearanceTokens=${json(APPLET_APPEARANCE_TOKENS)},defaultAppearance=${json(DEFAULT_APPLET_APPEARANCE)};let currentAppearance;
 const applyAppearance=value=>{
  if(!value||typeof value!=='object'||!['dark','light'].includes(value.colorScheme)||typeof value.theme!=='string'||!/^[a-z0-9-]{1,40}$/.test(value.theme)||typeof value.reducedMotion!=='boolean')return false;
  const safe=v=>typeof v==='string'&&v.length<=512&&!/[<>;{}@\\u0000-\\u001f]/.test(v)&&!/url\\s*\\(|expression\\s*\\(/i.test(v);
  if(!safe(value.fontFamily)||!safe(value.fontSize)||!value.tokens||typeof value.tokens!=='object'||Array.isArray(value.tokens))return false;
  const tokens={};for(const key of appearanceTokens){const token=value.tokens[key];if(token!==undefined){if(!safe(token))return false;tokens[key]=token}}
  currentAppearance=Object.freeze({theme:value.theme,colorScheme:value.colorScheme,fontFamily:value.fontFamily,fontSize:value.fontSize,reducedMotion:value.reducedMotion,tokens:Object.freeze(tokens)});
  const fallback={...defaultAppearance.tokens,...(value.colorScheme==='light'?{'--surface-base':'#ffffff','--surface-strong':'#f4f4f7','--surface-soft':'#ececf2','--surface-muted':'#e8e8ee','--surface-elevated':'#ffffff','--bg-primary':'#ffffff','--bg-secondary':'#f4f4f7','--bg-tertiary':'#ececf2','--text-primary':'#20212a','--text-secondary':'#515360','--text-muted':'#777987','--border':'#d7d8e0'}:{})};
  const root=document.documentElement;for(const key of appearanceTokens){const token=tokens[key]??fallback[key];if(token!==undefined)root.style.setProperty(key,token);else root.style.removeProperty(key)}
  root.style.setProperty('--mousse-color-scheme',value.colorScheme);root.style.setProperty('--mousse-font-family',value.fontFamily);root.style.setProperty('--mousse-font-size',value.fontSize);root.dataset.theme=value.theme;root.dataset.mousseReducedMotion=String(value.reducedMotion);
  document.dispatchEvent(new CustomEvent('mousse-appearance-change',{detail:currentAppearance}));return true;
 };
 Object.defineProperty(window,${json(APPLET_APPLY_APPEARANCE)},{value:applyAppearance,writable:false,configurable:false});applyAppearance(${json(initialAppearance)});
 const iconGeometry=${json(APPLET_ICON_GEOMETRY)},iconAliases=${json(APPLET_ICON_ALIASES)},iconNames=Object.freeze(Object.keys(iconGeometry));
 const makeIcon=(name,options={})=>{
  const canonical=Object.hasOwn(iconGeometry,name)?name:iconAliases[name];if(!canonical||!Object.hasOwn(iconGeometry,canonical))throw new Error('Unknown Mousse icon.');
  const size=typeof options.size==='number'&&Number.isFinite(options.size)?Math.min(128,Math.max(8,options.size)):16;
  const stroke=typeof options.strokeWidth==='number'&&Number.isFinite(options.strokeWidth)?Math.min(4,Math.max(.5,options.strokeWidth)):1.5;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');for(const [key,value] of Object.entries({width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':stroke,'stroke-linecap':'round','stroke-linejoin':'round','data-icon-library':'hugeicons','data-mousse-icon-name':canonical,class:'mousse-icon',focusable:'false'}))svg.setAttribute(key,String(value));
  const label=typeof options.label==='string'?options.label.slice(0,160):'';if(label){svg.setAttribute('role','img');svg.setAttribute('aria-label',label)}else svg.setAttribute('aria-hidden','true');
  for(const [tag,attributes] of iconGeometry[canonical]){const node=document.createElementNS(ns,tag);for(const [key,value] of Object.entries(attributes)){if(key==='key'||key==='strokeWidth')continue;const attr=key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());node.setAttribute(attr,String(value))}svg.appendChild(node)}return svg;
 };
 Object.defineProperty(window,'mousseApplet',{value:Object.freeze({get appearance(){return currentAppearance},icon:makeIcon,iconNames,data:${json(source.data)},state:${json(state)},saveState:value=>send('state',value),resize:height=>send('resize',height),reportError:message=>send('error',String(message).slice(0,2000)),requestConversationInput:text=>send('conversation-input',String(text).slice(0,4000))}),writable:false,configurable:false});
 addEventListener('error',event=>{event.preventDefault();send('error',String(event.message).slice(0,2000))});
 addEventListener('unhandledrejection',event=>{event.preventDefault();send('error','An applet promise failed.')});
 addEventListener('DOMContentLoaded',()=>{

  let visualTimer,visualPending=false;const visualChanged=()=>{visualPending=true;if(visualTimer)return;send('visual-changed',null);visualPending=false;visualTimer=setTimeout(()=>{visualTimer=undefined;if(visualPending)visualChanged()},80)};
  for(const type of ['input','change','click'])document.addEventListener(type,visualChanged,true);
  let scrollTimer;const scrollReports=new Map();const flushScroll=()=>{scrollTimer=undefined;if(!scrollReports.size)return;send('scroll-changed',[...scrollReports.values()]);scrollReports.clear()};
  const timers=new WeakMap();document.addEventListener('scroll',event=>{const node=event.target===document?document.documentElement:event.target;if(!(node instanceof Element))return;const path=[];let cursor=node;while(cursor&&cursor!==document.documentElement&&path.length<16){const parent=cursor.parentElement;if(!parent)break;path.unshift(Array.prototype.indexOf.call(parent.children,cursor));cursor=parent}if(cursor===document.documentElement){const key=JSON.stringify(path);if(scrollReports.size>=64&&!scrollReports.has(key))scrollReports.delete(scrollReports.keys().next().value);scrollReports.set(key,{path,top:node.scrollTop,left:node.scrollLeft});if(!scrollTimer){send('visual-changed',null);scrollTimer=setTimeout(flushScroll,100)}}node.classList.add('mousse-scrolling');clearTimeout(timers.get(node));timers.set(node,setTimeout(()=>{node.classList.remove('mousse-scrolling');timers.delete(node)},900))},true);
  const decorate=root=>{if(!(root instanceof Element))return;const nodes=[...(root.matches('[data-mousse-icon]')?[root]:[]),...root.querySelectorAll('[data-mousse-icon]')].slice(0,256);for(const node of nodes){const name=node.getAttribute('data-mousse-icon'),key=JSON.stringify([name,node.getAttribute('data-icon-size'),node.getAttribute('data-icon-label')]);if(node.dataset.mousseIconRendered===key)continue;try{node.replaceChildren(makeIcon(name,{size:Number(node.getAttribute('data-icon-size'))||16,label:node.getAttribute('data-icon-label')||''}));node.dataset.mousseIconRendered=key}catch{}}};decorate(document.body);new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')decorate(record.target);else for(const node of record.addedNodes)decorate(node)}}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-mousse-icon','data-icon-size','data-icon-label']});
  setTimeout(()=>{
  const savedScroll=${json(scrollPositions??[])};for(const position of savedScroll){let node=document.documentElement;for(const index of position.path)node=node?.children[index];if(node){node.scrollTop=position.top;node.scrollLeft=position.left}};send('ready',null)},0);let timer;new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>send('resize',Math.ceil(document.documentElement.scrollHeight)),100)}).observe(document.body)});
})();</script></head><body>${source.html}<style id="mousse-applet-final-style">${APPLET_HOST_STYLES}</style><script nonce="${nonce}">${script}</script></body></html>`
}
