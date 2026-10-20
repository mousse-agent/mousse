/// <reference types="vite/client" />
// onnxruntime-web ships its typings outside its package exports.
/// <reference path="../../node_modules/onnxruntime-web/types.d.ts" />

import type React from 'react'

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.svg?raw' {
  const src: string
  export default src
}

declare global {
  interface HTMLWebViewElement extends HTMLElement {
    src: string
    getURL(): string
    getWebContentsId(): number
    canGoBack(): boolean
    canGoForward(): boolean
    isLoading(): boolean
    loadURL(url: string): Promise<void>
    goBack(): void
    goForward(): void
    reload(): void
    reloadIgnoringCache(): void
    getTitle(): string
    setZoomFactor(factor: number): void
    openDevTools(): void
    executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLWebViewElement>,
        HTMLWebViewElement
      > & {
        src?: string
        partition?: string
        webpreferences?: string
      }
    }
  }
}

export {}
