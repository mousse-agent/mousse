import type { AppletAppearance } from './appletAppearance'

export const DEFAULT_APPLET_APPEARANCE: AppletAppearance = {
  theme: 'dark',
  colorScheme: 'dark',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '14px',
  reducedMotion: false,
  tokens: {
    '--accent': '#b7a0d8',
    '--accent-hover': '#c7b4e5',
    '--accent-pale': '#c7b4e5',
    '--accent-rgb': '183,160,216',
    '--accent-pale-rgb': '199,180,229',
    '--surface-base': '#1b1c23',
    '--surface-strong': '#24252e',
    '--surface-soft': '#2b2d38',
    '--surface-muted': '#171820',
    '--surface-elevated': '#30323e',
    '--bg-primary': '#1b1c23',
    '--bg-secondary': '#24252e',
    '--bg-tertiary': '#2b2d38',
    '--text-primary': '#f0f0f0',
    '--text-secondary': '#b7b8c1',
    '--text-muted': '#858694',
    '--border': '#393b48',
    '--gradient-accent': 'linear-gradient(135deg,#b7a0d8,#9580bb)',
    '--success': '#7ec99a',
    '--warning': '#e3bd71',
    '--danger': '#e07a8a',
    '--ui-control-radius': '6px',
    '--ui-card-radius': '10px',
    '--ui-row-radius': '6px',
    '--ui-gutter': '12px',
    '--ui-on-accent': '#ffffff',
    '--theme-btn-padding': '6px 14px',
    '--theme-btn-radius': '6px',
    '--theme-input-padding': '8px 12px',
    '--theme-input-radius': '6px',
    '--theme-card-padding': '12px 14px'
  }
}

/** Host rules follow source CSS. Scrollbars are enforced for every nested scroller. */
export const APPLET_HOST_STYLES = `
:root{--theme-spacing-xs:2px;--theme-spacing-sm:4px;--theme-spacing-md:6px;--theme-spacing-lg:8px;--theme-spacing-xl:12px;--theme-spacing-2xl:16px;--theme-spacing-3xl:24px;--theme-radius-sm:4px;--theme-radius-md:6px;--theme-radius-lg:8px;--theme-radius-xl:12px;--theme-radius-2xl:14px;color-scheme:var(--mousse-color-scheme)}
html{margin:0;min-height:100%;background:var(--surface-base,var(--bg-primary))!important;color:var(--text-primary);font-family:var(--mousse-font-family)!important;font-size:var(--mousse-font-size)!important}
body{margin:0;min-height:100vh;background:var(--surface-base,var(--bg-primary))!important;color:var(--text-primary);font-family:inherit;font-size:inherit}*,*::before,*::after{box-sizing:border-box}button,input,textarea,select{font:inherit}
:where(button){display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:var(--theme-btn-padding,6px 14px);border-radius:var(--theme-btn-radius,6px);border:0;font-size:13px;font-weight:500;line-height:1.4;background:rgba(var(--accent-rgb),.12);color:var(--text-secondary);transition:background .15s,opacity .15s,color .15s}:where(button:hover:not(:disabled)){background:rgba(var(--accent-pale-rgb),.2);color:var(--text-primary)}
button{cursor:pointer}button:disabled,input:disabled,select:disabled,textarea:disabled{opacity:.5;cursor:not-allowed}a{color:var(--vscode-textLink-foreground,var(--accent))}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--vscode-focusBorder,var(--accent));outline-offset:2px}
input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),textarea,select{padding:var(--theme-input-padding,8px 12px);border-radius:var(--theme-input-radius,6px);border:1px solid var(--vscode-input-border,var(--border));background:var(--vscode-input-background,var(--surface-strong));color:var(--vscode-input-foreground,var(--text-primary))}input::placeholder,textarea::placeholder{color:var(--vscode-input-placeholderForeground,var(--text-muted))}input[type=checkbox],input[type=radio],input[type=range]{accent-color:var(--accent)}
.btn,.icon-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;font-weight:500;line-height:1.4;color:var(--text-primary);background:var(--surface-soft);transition:background .15s,opacity .15s,color .15s}
.btn{padding:var(--theme-btn-padding,6px 14px);border-radius:var(--theme-btn-radius,6px);font-size:13px}.icon-btn{width:32px;height:32px;padding:0;border-radius:var(--ui-control-radius,6px);flex-shrink:0}
.btn-primary,.icon-btn-primary{background-image:var(--ui-sheen-accent,linear-gradient(transparent,transparent)),var(--gradient-accent);background-color:var(--vscode-button-background,var(--accent));color:var(--vscode-button-foreground,var(--ui-on-accent,#fff));box-shadow:var(--ui-specular-accent,inset 0 1px 0 #ffffff22),0 2px 10px rgba(var(--accent-rgb),.3)}.btn-primary:hover:not(:disabled),.icon-btn-primary:hover:not(:disabled){filter:brightness(1.08)}
.btn-ghost,.icon-btn-ghost{background:rgba(var(--accent-rgb),.12);color:var(--text-secondary)}.btn-ghost:hover:not(:disabled),.icon-btn-ghost:hover:not(:disabled){background:rgba(var(--accent-pale-rgb),.2);color:var(--text-primary)}
.btn-danger,.icon-btn-danger{background:var(--danger);color:var(--ui-on-accent,#fff)}.btn-success,.icon-btn-success{background:var(--success);color:var(--surface-muted,#171820)}.btn-danger:hover:not(:disabled),.btn-success:hover:not(:disabled){filter:brightness(1.08)}.btn:disabled,.icon-btn:disabled{box-shadow:none;opacity:.5;cursor:not-allowed}.btn-sm{padding:4px 10px;font-size:12px;min-height:26px}.mousse-icon{display:inline-block;vertical-align:middle;flex-shrink:0}
@layer mousse-applet-scrollbars{html,body,html body *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;scrollbar-width:thin!important;scrollbar-color:transparent transparent!important}
html:hover,html:focus-within,html.mousse-scrolling,body:hover,body:focus-within,body.mousse-scrolling,html body *:hover,html body *:focus-within,html body *.mousse-scrolling{scrollbar-color:var(--vscode-scrollbarSlider-background,rgba(var(--accent-rgb),.3)) transparent!important}
html::-webkit-scrollbar,body::-webkit-scrollbar,html body *::-webkit-scrollbar{width:6px!important;height:6px!important;display:block!important}
html::-webkit-scrollbar-track,body::-webkit-scrollbar-track,html body *::-webkit-scrollbar-track,html::-webkit-scrollbar-corner,body::-webkit-scrollbar-corner,html body *::-webkit-scrollbar-corner{background:transparent!important}
html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb,html body *::-webkit-scrollbar-thumb{background:transparent!important;border:0!important;border-radius:999px!important}
html:hover::-webkit-scrollbar-thumb,body:hover::-webkit-scrollbar-thumb,html body *:hover::-webkit-scrollbar-thumb,html:focus-within::-webkit-scrollbar-thumb,body:focus-within::-webkit-scrollbar-thumb,html body *:focus-within::-webkit-scrollbar-thumb,html.mousse-scrolling::-webkit-scrollbar-thumb,body.mousse-scrolling::-webkit-scrollbar-thumb,html body *.mousse-scrolling::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(var(--accent-rgb),.3))!important}
html::-webkit-scrollbar-thumb:hover,body::-webkit-scrollbar-thumb:hover,html body *::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,rgba(var(--accent-pale-rgb),.45))!important}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}html[data-mousse-reduced-motion=true] *,html[data-mousse-reduced-motion=true] *::before,html[data-mousse-reduced-motion=true] *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
`
