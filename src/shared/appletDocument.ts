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

/**
 * The document has no privileged preload. Its public bridge only reports untrusted data.
 *
 * Height: the page reports the height of its own content (the root element's box, which host styles never stretch
 * to the frame), at once on first layout and then 100 ms after it settles, so the frame can shrink as well as grow.
 * A frame that only changed height, with nothing in the page changed since the last report, must not move the
 * report: such content is sized to the frame (`vh`, `height:100%`), and following it would grow the frame forever.
 *
 * Liveness: the host asks the page to run a no-op script and stops it when no answer comes, so a page whose timers
 * the browser throttles (covered, hidden) stays alive and a page stuck in a loop does not. The page runs no heartbeat.
 *
 * Wheel: a wheel turn that nothing in the page can scroll (no scroller under the pointer with room left that way, and
 * none that sets `overscroll-behavior` to stop it) is reported, and the host scrolls the conversation instead, as it
 * would over any other part of a reply. Once an inner scroller reaches its end the rest of the turn goes on to the
 * conversation. Pinch and ctrl+wheel are left alone. Wheel reports have their own budget, so they never starve others.
 *
 * Backdrop: `transparent` (the app) leaves the page itself unpainted, so the chat or panel behind it shows through,
 * its theme surface or the acrylic window, as behind a reply. A standalone export keeps the opaque theme surface.
 */
export function appletDocument(
  source: AppletSource,
  state?: unknown,
  appearance?: AppletAppearance,
  scrollPositions?: Array<{path:number[];top:number;left:number}>,
  options: { transparent?: boolean } = {}
): string {
  const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('')
  const initialAppearance = validateAppletAppearance(appearance ?? DEFAULT_APPLET_APPEARANCE)
  const json = (value: unknown) => JSON.stringify(value ?? null).replace(/</g, '\\u003c')
  const script = source.js.replace(/<\/script/gi, '<\\/script')
  const css = source.css.replace(/<\/style/gi, '<\\/style')
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`
  return `<!doctype html><html${options.transparent ? ' data-mousse-backdrop="transparent"' : ''}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@layer mousse-applet-scrollbars;</style><style>${css}</style><style id="mousse-applet-host-style">${APPLET_HOST_STYLES}</style><script nonce="${nonce}">
(()=>{
 for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport'])Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false});
 for(const [key,value] of Object.entries({alert:()=>{},confirm:()=>false,prompt:()=>null,print:()=>{}}))Object.defineProperty(window,key,{value,writable:false,configurable:false});
 const log=console.log.bind(console),clock=performance.now.bind(performance),styleOf=getComputedStyle.bind(window);let count=0,epoch=-1e9;
 Object.defineProperty(window,'console',{value:Object.freeze(Object.fromEntries(Object.getOwnPropertyNames(console).map(key=>[key,()=>{}]))),writable:false,configurable:false});
 const post=(type,payload)=>{try{const message=JSON.stringify({type,payload});if(message.length<=65536)log(${json(APPLET_EVENT_PREFIX)}+message)}catch{}};
 const send=(type,payload)=>{const now=clock();if(now-epoch>=1000){epoch=now;count=0}if(++count>30)return;post(type,payload)};
 const scrolls=(node,vertical,delta)=>{const style=styleOf(node),overflow=vertical?style.overflowY:style.overflowX,root=node===document.scrollingElement;if(root?/hidden|clip/.test(overflow):!/auto|scroll|overlay/.test(overflow))return 0;const max=vertical?node.scrollHeight-node.clientHeight:node.scrollWidth-node.clientWidth;if(max<1)return 0;const at=vertical?node.scrollTop:Math.abs(node.scrollLeft);if(delta<0?at>.5:at<max-.5)return 1;return (vertical?style.overscrollBehaviorY:style.overscrollBehaviorX)==='auto'?0:2};
 let wheelCount=0,wheelEpoch=-1e9,wheelCarry=0;
 addEventListener('wheel',event=>{
  if(!event.isTrusted||event.defaultPrevented||event.ctrlKey)return;
  const scale=event.deltaMode===1?40:event.deltaMode===2?innerHeight:1,dy=event.deltaY*scale,dx=event.deltaX*scale;
  if(!dy||Math.abs(dx)>Math.abs(dy))return;
  let sideways=false;for(const node of event.composedPath()){if(!(node instanceof Element))continue;const own=scrolls(node,true,dy);if(own)return;if(dx&&!sideways&&scrolls(node,false,dx)===1)sideways=true}
  if(!sideways)event.preventDefault();
  wheelCarry=Math.max(-10000,Math.min(10000,wheelCarry+dy));const now=clock();if(now-wheelEpoch>=1000){wheelEpoch=now;wheelCount=0}if(++wheelCount>120)return;
  post('wheel',{deltaY:Math.round(wheelCarry*100)/100,discrete:event.deltaMode!==0||event.wheelDeltaY!==0&&event.wheelDeltaY%120===0});wheelCarry=0
 },{passive:false});
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
 const iconGeometry=${json(APPLET_ICON_GEOMETRY)},missingIcon=[["circle",{cx:12,cy:12,r:8,strokeDasharray:"2 3"}]],iconAliases=${json(APPLET_ICON_ALIASES)},iconNames=Object.freeze(Object.keys(iconGeometry));
 const makeIcon=(name,options={})=>{
  const known=Object.hasOwn(iconGeometry,name)?name:Object.hasOwn(iconAliases,name)?iconAliases[name]:undefined,canonical=known&&Object.hasOwn(iconGeometry,known)?known:undefined;
  const size=typeof options.size==='number'&&Number.isFinite(options.size)?Math.min(128,Math.max(8,options.size)):16;
  const stroke=typeof options.strokeWidth==='number'&&Number.isFinite(options.strokeWidth)?Math.min(4,Math.max(.5,options.strokeWidth)):1.5;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');for(const [key,value] of Object.entries({width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':stroke,'stroke-linecap':'round','stroke-linejoin':'round','data-icon-library':'hugeicons','data-mousse-icon-name':canonical??'missing',class:'mousse-icon',focusable:'false'}))svg.setAttribute(key,String(value));
  const label=typeof options.label==='string'?options.label.slice(0,160):'';if(label){svg.setAttribute('role','img');svg.setAttribute('aria-label',label)}else svg.setAttribute('aria-hidden','true');
  for(const [tag,attributes] of canonical?iconGeometry[canonical]:missingIcon){const node=document.createElementNS(ns,tag);for(const [key,value] of Object.entries(attributes)){if(key==='key'||key==='strokeWidth')continue;const attr=key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());node.setAttribute(attr,String(value))}svg.appendChild(node)}return svg;
 };
 Object.defineProperty(window,'mousseApplet',{value:Object.freeze({get appearance(){return currentAppearance},icon:makeIcon,iconNames,data:${json(source.data)},state:${json(state)},saveState:value=>send('state',value),resize:height=>send('resize',height),reportError:message=>send('error',String(message).slice(0,2000)),requestConversationInput:text=>send('conversation-input',String(text).slice(0,4000))}),writable:false,configurable:false});
 addEventListener('error',event=>{event.preventDefault();const message=String(event.message);if(message.startsWith('ResizeObserver loop'))return;send('error',message.slice(0,2000))});
 addEventListener('unhandledrejection',event=>{event.preventDefault();send('error','An applet promise failed.')});
 addEventListener('DOMContentLoaded',()=>{

  let visualTimer,visualPending=false;const visualChanged=()=>{visualPending=true;if(visualTimer)return;send('visual-changed',null);visualPending=false;visualTimer=setTimeout(()=>{visualTimer=undefined;if(visualPending)visualChanged()},80)};
  for(const type of ['input','change','click'])document.addEventListener(type,visualChanged,true);
  let scrollTimer;const scrollReports=new Map();const flushScroll=()=>{scrollTimer=undefined;if(!scrollReports.size)return;send('scroll-changed',[...scrollReports.values()]);scrollReports.clear()};
  const timers=new WeakMap();document.addEventListener('scroll',event=>{const node=event.target===document?document.documentElement:event.target;if(!(node instanceof Element))return;const path=[];let cursor=node;while(cursor&&cursor!==document.documentElement&&path.length<16){const parent=cursor.parentElement;if(!parent)break;path.unshift(Array.prototype.indexOf.call(parent.children,cursor));cursor=parent}if(cursor===document.documentElement){const key=JSON.stringify(path);if(scrollReports.size>=64&&!scrollReports.has(key))scrollReports.delete(scrollReports.keys().next().value);scrollReports.set(key,{path,top:node.scrollTop,left:node.scrollLeft});if(!scrollTimer){send('visual-changed',null);scrollTimer=setTimeout(flushScroll,100)}}node.classList.add('mousse-scrolling');clearTimeout(timers.get(node));timers.set(node,setTimeout(()=>{node.classList.remove('mousse-scrolling');timers.delete(node)},900))},true);
  const decorate=root=>{if(!(root instanceof Element))return;const nodes=[...(root.matches('[data-mousse-icon]')?[root]:[]),...root.querySelectorAll('[data-mousse-icon]')].slice(0,256);for(const node of nodes){const name=node.getAttribute('data-mousse-icon'),key=JSON.stringify([name,node.getAttribute('data-icon-size'),node.getAttribute('data-icon-label')]);if(node.dataset.mousseIconRendered===key)continue;try{node.replaceChildren(makeIcon(name,{size:Number(node.getAttribute('data-icon-size'))||16,label:node.getAttribute('data-icon-label')||''}));node.dataset.mousseIconRendered=key}catch{}}};decorate(document.body);new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')decorate(record.target);else for(const node of record.addedNodes)decorate(node)}}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-mousse-icon','data-icon-size','data-icon-label']});
  setTimeout(()=>{
  const savedScroll=${json(scrollPositions??[])};for(const position of savedScroll){let node=document.documentElement;for(const index of position.path)node=node?.children[index];if(node){node.scrollTop=position.top;node.scrollLeft=position.left}};send('ready',null)},0);
  let sizeTimer,sized,changed=true;
  const reportSize=()=>{sizeTimer=undefined;const height=Math.ceil(document.documentElement.getBoundingClientRect().height),width=innerWidth,viewport=innerHeight;if(sized&&height===sized.height)return;if(sized&&!changed&&width===sized.width&&viewport!==sized.viewport)return;changed=false;sized={height,width,viewport};send('resize',height)};
  const ownMark=record=>record.type==='attributes'&&(record.attributeName==='data-mousse-icon-rendered'||record.attributeName==='class'&&String(record.oldValue??'').split(/\\s+/).filter(name=>name&&name!=='mousse-scrolling').join(' ')===[...record.target.classList].filter(name=>name!=='mousse-scrolling').join(' '));
  new MutationObserver(records=>{if(records.some(record=>!ownMark(record)))changed=true}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeOldValue:true,characterData:true});
  for(const type of ['load','transitionend','animationend'])document.addEventListener(type,()=>{changed=true},true);
  const sizes=new ResizeObserver(()=>{clearTimeout(sizeTimer);if(sized)sizeTimer=setTimeout(reportSize,100);else reportSize()});sizes.observe(document.documentElement);sizes.observe(document.body)});
})();</script></head><body>${source.html}<style id="mousse-applet-final-style">${APPLET_HOST_STYLES}</style><script nonce="${nonce}">${script}</script></body></html>`
}
